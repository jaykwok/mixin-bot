// Tools that take a path from the model agree on where it points: Durable's read, edit and write (through the member
// environment) and the project's resolver (send_file, document_extract, the document tools).
import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ok } from "@earendil-works/pi-durable/env";
import { createWriteTool } from "@earendil-works/pi-durable/tools";
import { deleteSnapshots, freezeFile } from "../../src/agent/deliverables.ts";
import { resolveSource } from "../../src/agent/send-tools.ts";
import { realToolPath, resolveToolPath } from "../../src/agent/tool-path.ts";
import { groupScope } from "../../src/core/layout.ts";
import { createMemberEnv } from "../../src/durable/member-env.ts";
import { tempFixture } from "../helpers/temp.ts";

test("a path means the same to Durable's write tool and to the project's resolver", async () => {
  const files = await tempFixture("pi-path-");
  try {
    const cwd = join(files.root, "workspace with spaces"), tempDir = join(files.root, "tmp"), absolute = join(cwd, "notes.md");
    for (const path of [cwd, tempDir]) await mkdir(path, { recursive: true });
    const member = await createMemberEnv({ workspaceDir: cwd, tempDir, phone: "100", scope: groupScope("g"), venvDir: join(files.root, "venv"),
      materialsIndexPath: join(files.root, "index", "materials.json") });
    let written: string | undefined;
    const env = { id: member.id, absolutePath: member.absolutePath, joinPath: member.joinPath, canonicalPath: async (path: string) => ok(path),
      writeFile: async (path: string) => { written = path; return ok(undefined); } };
    const shellPath = absolute.replaceAll("\\", "/").replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`);
    const cases = ["notes.md", "@notes.md", "@@notes.md", "sub/../notes.md", " leading space.md", "notes file.md", "notes file.md", "notes　file.md",
      "~", "~/notes.md", pathToFileURL(absolute).href, absolute,
      ...(process.platform === "win32" ? [shellPath, `/mnt${shellPath}`, `/cygdrive${shellPath}`, "~\\notes.md", "/d", "//server/share/notes.md"] : [])];
    for (const path of cases) {
      written = undefined;
      await createWriteTool().execute({ path, content: "after" }, { env } as never, context);
      expect([path, written]).toEqual([path, resolveToolPath(path, cwd)]);
    }
    expect(resolveToolPath("~/notes.md", cwd)).toBe(join(homedir(), "notes.md"));
    if (process.platform === "win32") {
      for (const path of [shellPath, `/mnt${shellPath}`, `/cygdrive${shellPath}`]) expect(resolveToolPath(path, cwd)).toBe(absolute);
    }
  } finally { await files.cleanup(); }
});

test("a delivery snapshot cleaned up after its request explains itself; other missing files keep the plain error", async () => {
  const files = await tempFixture("pi-snapshot-");
  try {
    const workspace = join(files.root, "workspace"), tempDir = join(files.root, "tmp"), source = join(tempDir, "方案.pptx");
    for (const path of [join(workspace, ".deliverables"), tempDir]) await mkdir(path, { recursive: true });
    await writeFile(source, "deck");
    const frozen = await freezeFile(source, tempDir, "msg:1", 1024);
    expect(await realToolPath(frozen.path, workspace)).toBe(frozen.path);
    await deleteSnapshots([frozen.path], tempDir);
    // The model writes the path with either separator; send_file and the document tools go through the same resolver.
    for (const path of [frozen.path, frozen.path.replaceAll("\\", "/")]) {
      await expect(realToolPath(path, workspace)).rejects.toThrow(/快照.*已清理.*原来的生成路径/);
      await expect(resolveSource(path, workspace, tempDir)).rejects.toThrow(/快照.*已清理/);
    }
    // Not a snapshot: a missing file elsewhere, and a folder of that name in the materials.
    await expect(realToolPath(join(tempDir, "missing.pptx"), workspace)).rejects.toThrow(/ENOENT/);
    await expect(realToolPath(".deliverables/missing.pptx", workspace)).rejects.toThrow(/ENOENT/);
    await expect(realToolPath(join(tempDir, ".deliverables", "a", "b", "missing.pptx"), workspace)).rejects.toThrow(/ENOENT/);
  } finally { await files.cleanup(); }
});
