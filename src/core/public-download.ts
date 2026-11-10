import dns from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { waitFor } from "./lifecycle.ts";

function addressNumber(address: string): { value: bigint; bits: number } | undefined {
  const family = isIP(address);
  if (family === 4) return { value: address.split(".").reduce((n, part) => n * 256n + BigInt(part), 0n), bits: 32 };
  if (family !== 6 || address.includes("%")) return;
  // URL normalizes embedded IPv4 tails into hex words as well as compressed notation.
  const normalized = new URL("http://[" + address + "]").hostname.slice(1, -1);
  const [left, right] = normalized.split("::");
  const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  return { value: words.reduce((n, word) => n * 65536n + BigInt("0x" + word), 0n), bits: 128 };
}

function inRange(value: bigint, bits: number, network: string, prefix: number): boolean {
  return value >> BigInt(bits - prefix) === addressNumber(network)!.value >> BigInt(bits - prefix);
}

// Conservatively exclude special-use ranges, including IPv4 translation/transition addresses.
// Public exceptions inside these ranges are intentionally not accepted by attachment downloads.
export function isPublicAddress(address: string): boolean {
  const parsed = addressNumber(address);
  if (!parsed) return false;
  const { value, bits } = parsed;
  if (bits === 32) {
    const excluded: [string, number][] = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]];
    return !excluded.some(([network, prefix]) => inRange(value, bits, network, prefix));
  }
  return inRange(value, bits, "2000::", 3) && ![["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]
    .some(([network, prefix]) => inRange(value, bits, network as string, prefix as number));
}

function sameAddress(actual: string, expected: string): boolean {
  const a = addressNumber(actual), b = addressNumber(expected);
  if (!a || !b) return false;
  // A dual-stack socket may report a vetted IPv4 peer as an IPv4-mapped IPv6 address.
  if (a.bits === 128 && b.bits === 32) return a.value >> 32n === 0xffffn && (a.value & 0xffffffffn) === b.value;
  return a.bits === b.bits && a.value === b.value;
}

/** The file is larger than the caller takes: `size` as declared, or as received when the limit was passed. */
export class DownloadTooLarge extends Error {
  constructor(readonly size: number) { super("远程文件超过附件大小上限"); }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function readResponse(response: IncomingMessage, maxBytes: number): Promise<Uint8Array | { location: string }> {
  try {
    const status = response.statusCode ?? 0, location = response.headers.location;
    if (REDIRECTS.has(status) && location) return { location };
    if (status < 200 || status >= 300) throw new Error("下载失败 HTTP " + status);
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) throw new DownloadTooLarge(declared);
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw new DownloadTooLarge(total);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  } finally { response.destroy(); }
}

/** One request: one DNS lookup, checked in full, pinned to one connection; no proxy or shared sockets. */
async function requestPublic(source: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | { location: string }> {
  signal.throwIfAborted();
  const url = new URL(source);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("下载仅支持不含凭据的公网 HTTP(S) URL");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await waitFor(dns.lookup(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.length > 64 || addresses.some(item => !isPublicAddress(item.address))) {
    throw new Error("禁止访问非公网地址：只能下载公网 HTTP(S) 地址上的文件");
  }
  signal.throwIfAborted();
  const pinned = addresses[0]!;
  return new Promise<Uint8Array | { location: string }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https.request : http.request)(url, {
      agent: false, signal, family: pinned.family,
      headers: { "Accept-Encoding": "identity" },
      lookup(_name, options, callback) {
        if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
    }, response => { void readResponse(response, maxBytes).then(resolve, reject); });
    request.on("error", reject);
    request.on("socket", socket => {
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
        if (!socket.remoteAddress || !sameAddress(socket.remoteAddress, pinned.address)) {
          request.destroy(new Error("下载连接地址与已校验的公网地址不一致")); return;
        }
        request.end();
      });
    });
  });
}

/**
 * Download from a public address. `redirects`: how many redirects are followed; every one is a new request, checked and
 * pinned like the first, so a public address cannot pass the download on to a private one. With 0 a redirect is refused.
 */
export async function downloadPublicBytes(source: string, maxBytes: number, signal: AbortSignal, redirects = 0): Promise<Uint8Array> {
  let url = source;
  for (let followed = 0; ; followed++) {
    const result = await requestPublic(url, maxBytes, signal);
    if (!("location" in result)) return result;
    if (!redirects) throw new Error("不允许下载重定向，请提供文件的最终公网 URL");
    if (followed >= redirects) throw new Error(`下载重定向超过 ${redirects} 次`);
    try { url = new URL(result.location, url).href; }
    catch { throw new Error("下载重定向的地址无效"); }
  }
}
