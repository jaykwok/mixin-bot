// The libSystem facts src/lib/darwin.ts is built on (measured on macOS 15 and 26), checked where they hold: macOS on
// Apple silicon. The refusal of a volume that is not APFS is in held-directory.test.ts.
import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, rename, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { assertApfs, AT_FDCWD, close, descriptorPath, directoryRemoved, namesAt, O, openAt } from "../../src/lib/darwin.ts";
import { tempFixture } from "../helpers/temp.ts";

const native = process.platform === "darwin" && process.arch === "arm64";
const code = (work: () => unknown) => { try { work(); return "none"; } catch (error) { return (error as NodeJS.ErrnoException).code; } };

test.skipIf(!native)("openat creates files with exactly the mode asked for (the variadic mode goes to the stack slot), and errors carry errno's code", async () => {
  const fixture = await tempFixture("darwin-open-");
  const dir = openAt(AT_FDCWD, fixture.root, O.RDONLY | O.DIRECTORY);
  try {
    for (const [name, mode] of [["a", 0o600], ["b", 0o640], ["c", 0o604]] as const) {
      close(openAt(dir, name, O.WRONLY | O.CREAT | O.EXCL, mode));
      expect((await stat(join(fixture.root, name))).mode & 0o777).toBe(mode);
    }
    expect([code(() => openAt(dir, "missing", O.RDONLY)), code(() => openAt(dir, "a", O.WRONLY | O.CREAT | O.EXCL, 0o600))]).toEqual(["ENOENT", "EEXIST"]);
    // Listing goes through a descriptor of its own; the path of an open one comes from proc_pidfdinfo.
    expect(namesAt(dir).sort()).toEqual(["a", "b", "c"]);
    expect(namesAt(dir).sort()).toEqual(["a", "b", "c"]);
    expect(descriptorPath(dir)).toBe(realpathSync(fixture.root));
  } finally { close(dir); await fixture.cleanup(); }
});

test.skipIf(!native)("an open directory that was removed lists no entry at all; one only moved still lists . and ..; the test directory is on APFS", async () => {
  const fixture = await tempFixture("darwin-removed-");
  await mkdir(join(fixture.root, "removed")); await mkdir(join(fixture.root, "moved"));
  const removed = openAt(AT_FDCWD, join(fixture.root, "removed"), O.RDONLY | O.DIRECTORY), moved = openAt(AT_FDCWD, join(fixture.root, "moved"), O.RDONLY | O.DIRECTORY);
  try {
    assertApfs(removed);
    expect([directoryRemoved(removed), directoryRemoved(moved)]).toEqual([false, false]);
    await rmdir(join(fixture.root, "removed"));
    await rename(join(fixture.root, "moved"), join(fixture.root, "elsewhere"));
    expect([directoryRemoved(removed), directoryRemoved(moved)]).toEqual([true, false]);
  } finally { close(removed); close(moved); await fixture.cleanup(); }
});
