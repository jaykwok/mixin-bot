import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Takeover } from "../../src/durable/takeover.ts";
import { operatorAttachment, readTakeoverUpload } from "../../src/contracts/takeover-upload.ts";
import type { OutboundMessage, SendOutcome, Target } from "../../src/integrations/open-platform/messages.ts";
import { tempFixture } from "../helpers/temp.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9SAAAAAASUVORK5CYII=", "base64");
const attachment = (kind: "image" | "file" = "file") => ({ kind, file: new File([kind === "image" ? png : Buffer.from("attachment body")], kind === "image" ? "截图.png" : "清单.txt") });
async function harness() {
  const fixture = await tempFixture("takeover-media-");
  const conversations = join(fixture.root, "conversations");
  for (const space of ["direct", "groups/123"]) { mkdirSync(join(conversations, space), { recursive: true }); writeFileSync(join(conversations, space, "durable.sqlite"), ""); }
  const sent: { target: Target; message: OutboundMessage }[] = [], notes: string[] = [], uploads: { path: string; bytes: Buffer; mime: string }[] = [];
  let halted = 0;
  const state: { uploadFailed?: boolean; fileOutcome?: SendOutcome; afterUpload?: () => void; removed?: boolean; imUserId?: string } = {};
  const takeover = new Takeover({ layout: { conversations }, signal: new AbortController().signal, noteRetryMs: [],
    host: { hasConversation: async () => true, halt: async () => { halted++; return { waiting: [] }; }, note: async (_scope, _phone, _id, entry) => { notes.push(JSON.stringify(entry)); } },
    directory: { byPhone: phone => state.removed ? undefined : ({ phone, name: "测试成员", imUserId: state.imUserId ?? "im-member" }) },
    outbound: {
      upload: async source => { if (state.uploadFailed) throw new Error("upload refused"); uploads.push({ path: source.path, bytes: await readFile(source.path), mime: source.mimeType }); state.afterUpload?.(); return "uploaded-id"; },
      sequence: async (target, work) => work(async message => { sent.push({ target, message }); return message.msgType !== "markdown" && state.fileOutcome ? state.fileOutcome : { status: "sent" }; }),
      send: async () => { throw new Error("must send in sequence"); }, links: async () => "",
    },
  });
  return { fixture, takeover, sent, notes, uploads, state, halted: () => halted };
}

test("takeover sends native image/file bytes, records names, cleans staging, and mentions group recipients", async () => {
  const h = await harness();
  try {
    const result = await h.takeover.say("direct", "member", "请查收", attachment());
    expect(result).toMatchObject({ sent: "sent", recorded: true, attachment: { kind: "file", name: "清单.txt", sent: "sent" } });
    expect(h.sent.map(item => item.message.msgType)).toEqual(["markdown", "file"]);
    expect(h.sent[1]?.message.content).toMatchObject({ fileId: "uploaded-id", fileName: "清单.txt" });
    expect(h.uploads[0]!.bytes.toString()).toBe("attachment body"); expect(existsSync(h.uploads[0]!.path)).toBe(false);
    expect(h.notes[0]).toContain("清单.txt"); expect(h.notes[0]).not.toContain("mixin-operator-");
    h.sent.length = 0;
    await h.takeover.say("groups/123", "member", "", attachment("image"));
    expect(h.sent.map(item => item.message.msgType)).toEqual(["markdown", "image"]);
    expect(h.sent[0]?.message.content).toMatchObject({ a: [{ i: "im-member" }] });
    expect(h.sent[1]).toMatchObject({ target: { kind: "group", receiveId: "123" }, message: { content: { fileId: "uploaded-id", width: 1, height: 1, mimeType: "png" } } });
    expect(h.uploads[1]!.bytes).toEqual(png); expect(h.uploads[1]!.mime).toBe("image/png");
  } finally { await h.fixture.cleanup(); }
});

test("invalid or failed uploads never halt/send; later media failure keeps only delivered text in history", async () => {
  const h = await harness();
  try {
    await expect(h.takeover.say("direct", "member", "caption", { kind: "image", file: attachment().file })).rejects.toThrow("无法识别图片");
    h.state.uploadFailed = true;
    await expect(h.takeover.say("direct", "member", "caption", attachment())).rejects.toThrow("附件上传失败");
    expect(h.halted()).toBe(0); expect(h.sent).toHaveLength(0);
    h.state.uploadFailed = false; h.state.fileOutcome = { status: "failed", reason: "rejected" };
    expect(await h.takeover.say("direct", "member", "已发文字", attachment())).toMatchObject({ sent: "partial", segments: { sent: 1, total: 2 }, attachment: { sent: "failed" } });
    expect(h.notes[0]).toContain("已发文字"); expect(h.notes[0]).not.toContain("清单.txt");
    h.state.fileOutcome = { status: "uncertain", reason: "timeout" };
    expect(await h.takeover.say("direct", "member", "", attachment())).toMatchObject({ sent: "uncertain", attachment: { sent: "uncertain" } });
    expect(h.notes[1]).toContain("平台未确认送达");
  } finally { await h.fixture.cleanup(); }
});

test("a directory change during upload is checked before halting or sending", async () => {
  const h = await harness();
  try {
    h.state.afterUpload = () => { h.state.removed = true; };
    await expect(h.takeover.say("direct", "member", "", attachment())).rejects.toThrow("不在机器人同步的通讯录范围");
    expect(h.halted()).toBe(0); expect(h.sent).toHaveLength(0);
    h.state.removed = false; h.state.afterUpload = () => { h.state.imUserId = "current-id"; };
    await h.takeover.say("direct", "member", "", attachment());
    expect(h.sent[0]?.target).toEqual({ kind: "direct", receiveId: "current-id" });
  } finally { await h.fixture.cleanup(); }
});

test("takeover upload bounds bytes and fields, rejects expired sessions and paths", async () => {
  const form = new FormData(); form.set("message", JSON.stringify({ view: "v", member: "m", kind: "file", text: "说明" })); form.set("file", attachment().file);
  const request = () => new Request("http://localhost/upload", { method: "POST", body: form });
  const parsed = await readTakeoverUpload(request());
  expect(parsed.metadata.text).toBe("说明"); expect(await parsed.attachment.file.text()).toBe("attachment body");
  await expect(readTakeoverUpload(request(), () => false)).rejects.toThrow("登录已失效");
  const oversized = request(); oversized.headers.set("content-length", String(31 * 1024 * 1024));
  await expect(readTakeoverUpload(oversized)).rejects.toThrow("30 MB");
  form.append("file", attachment().file); await expect(readTakeoverUpload(request())).rejects.toThrow("一次只支持");
  expect(() => operatorAttachment("file", new File(["x"], "../secret"))).toThrow("文件名");
  expect(() => operatorAttachment("file", new File([], "empty"))).toThrow("非空");
});
