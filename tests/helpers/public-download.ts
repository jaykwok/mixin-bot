import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { spyOn } from "bun:test";
let dnsCalls = 0, requests = 0, sent = 0, status = 200, peer = "93.184.215.14", declared: string | undefined;
let answers = [{ address: "93.184.215.14", family: 4 }], body = [Buffer.from("hello")], hold = false;
// rebind: the resolver turns private after a request. queue: the statuses of the next responses. location: their Location header.
let rebind = true, queue: number[] = [], location: string | undefined;
spyOn(dns, "lookup").mockImplementation((async () => { dnsCalls++; return answers; }) as unknown as typeof dns.lookup);
const request = (url: URL, options: any, respond: (response: any) => void) => {
  requests++; assert.equal(options.agent, false); assert.equal(url.hostname, "public.example");
  assert.equal(options.rejectUnauthorized, undefined); // Node's default certificate/hostname verification stays enabled.
  assert.equal(options.headers["Accept-Encoding"], "identity");
  // A later resolver answer becomes private. The connection lookup must still return the vetted address.
  if (rebind) answers = [{ address: "127.0.0.1", family: 4 }];
  for (const all of [false, true]) options.lookup("public.example", { all }, (error: unknown, address: any, family?: number) => {
    assert.equal(error, null);
    assert.deepEqual(all ? address : [{ address, family }], [{ address: "93.184.215.14", family: 4 }]);
  });
  const req: any = new EventEmitter();
  req.destroy = (error: Error) => req.emit("error", error);
  req.end = () => {
    sent++;
    if (hold) return;
    const response: any = Readable.from(body); response.statusCode = queue.shift() ?? status; response.headers = { "content-length": declared, ...(location === undefined ? {} : { location }) };
    respond(response);
  };
  options.signal.addEventListener("abort", () => req.destroy(options.signal.reason), { once: true });
  queueMicrotask(() => { const socket: any = new EventEmitter(); socket.remoteAddress = peer; req.emit("socket", socket); socket.emit(url.protocol === "https:" ? "secureConnect" : "connect"); });
  return req;
};
spyOn(http, "request").mockImplementation(request as unknown as typeof http.request);
spyOn(https, "request").mockImplementation(request as unknown as typeof https.request);
const { downloadPublicBytes, DownloadTooLarge } = await import("../../src/core/public-download.ts");
const reset = () => { answers = [{ address: "93.184.215.14", family: 4 }]; status = 200; peer = "93.184.215.14"; declared = undefined; body = [Buffer.from("hello")]; rebind = true; queue = []; location = undefined; };
assert.equal(Buffer.from(await downloadPublicBytes("https://public.example/file", 10, AbortSignal.timeout(2000))).toString(), "hello");
assert.equal(dnsCalls, 1); assert.equal(requests, 1); assert.equal(sent, 1);
reset(); answers.push({ address: "10.0.0.1", family: 4 });
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /非公网/);
assert.equal(requests, 1);
reset(); status = 302; location = "https://elsewhere.example/file";
await assert.rejects(downloadPublicBytes("https://public.example/redirect", 10, AbortSignal.timeout(2000)), /重定向/);
assert.equal(requests, 2); // No second request, regardless of Location.
reset(); peer = "127.0.0.1"; const before = sent;
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /地址不一致/);
assert.equal(sent, before); // Verify the peer before sending any HTTP headers.
reset(); peer = "::ffff:93.184.215.14";
assert.equal((await downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000))).length, 5);
reset(); declared = "11";
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /大小上限/);
reset(); body = [Buffer.from("123456"), Buffer.from("123456")];
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), /大小上限/);
// A redirect without a Location, or a 3xx that is not one, is a failed download.
reset(); status = 302;
await assert.rejects(downloadPublicBytes("https://public.example/file", 10, AbortSignal.timeout(2000), 5), /HTTP 302/);
reset(); status = 304; location = "/other";
await assert.rejects(downloadPublicBytes("https://public.example/file", 10, AbortSignal.timeout(2000), 5), /HTTP 304/);
// Where the caller follows redirects, every hop is resolved, checked and pinned again.
reset(); rebind = false; queue = [302, 301]; location = "/final";
let lookups = dnsCalls, made = requests;
assert.equal(Buffer.from(await downloadPublicBytes("https://public.example/start", 10, AbortSignal.timeout(2000), 5)).toString(), "hello");
assert.equal(dnsCalls - lookups, 3); assert.equal(requests - made, 3);
// A redirect to a name that resolves to a private address is refused before any connection to it.
reset(); queue = [302]; location = "http://public.example/internal"; made = requests;
await assert.rejects(downloadPublicBytes("https://public.example/start", 10, AbortSignal.timeout(2000), 5), /非公网/);
assert.equal(requests - made, 1);
// So is one to a private address written out, or to another scheme.
reset(); rebind = false; queue = [302]; location = "http://169.254.169.254/latest/meta-data"; made = requests; lookups = dnsCalls;
await assert.rejects(downloadPublicBytes("https://public.example/start", 10, AbortSignal.timeout(2000), 5), /非公网/);
assert.equal(requests - made, 1); assert.equal(dnsCalls - lookups, 1);
reset(); rebind = false; queue = [302]; location = "file:///etc/passwd"; made = requests;
await assert.rejects(downloadPublicBytes("https://public.example/start", 10, AbortSignal.timeout(2000), 5), /HTTP\(S\)/);
assert.equal(requests - made, 1);
// No more hops than the caller allows.
reset(); rebind = false; status = 302; location = "/again"; made = requests;
await assert.rejects(downloadPublicBytes("https://public.example/start", 10, AbortSignal.timeout(2000), 2), /重定向超过 2 次/);
assert.equal(requests - made, 3);
// The size is reported with the refusal.
reset(); declared = "11";
await assert.rejects(downloadPublicBytes("http://public.example/", 10, AbortSignal.timeout(2000)), (error: unknown) => error instanceof DownloadTooLarge && error.size === 11);
reset(); hold = true; const abort = new AbortController();
const pending = downloadPublicBytes("http://public.example/", 10, abort.signal);
setTimeout(() => abort.abort(new Error("cancelled download")), 10);
await assert.rejects(pending, /cancelled download/);
console.log("PUBLIC_DOWNLOAD_PASSED");
