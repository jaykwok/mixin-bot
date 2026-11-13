import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { latestRelease } from "../../ops/core/releases.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));

test("最新发布按数字比较，只认 vX.Y.Z（每段至多九位）；读不到标签或解析不出提交时拒绝", async () => {
  const target = "a".repeat(40), seen: string[][] = [];
  const git = (tags: string, code = 0) => async (args: string[]) => {
    seen.push(args);
    if (args[0] === "for-each-ref") return { code, stdout: tags };
    if (args.includes("refs/tags/v10.0.999999999^{commit}")) return { code: 0, stdout: target + "\n" };
    if (args.includes("refs/heads/main^{commit}")) return { code: 128, stdout: "" };
    return { code: 1, stdout: "" };
  };
  const tags = "v9.99.99\r\nv10.0.2\r\n v10.0.999999999 \r\nv10.0.1000000000\r\nv10.0.3+build\r\nV11.0.0\r\nv11.0\r\n";
  expect(await latestRelease(git(tags))).toEqual({ tag: "v10.0.999999999", commit: target, behind: false });
  // Without local main nothing is compared with it; the upgrader refuses later.
  expect(seen.some(args => args[0] === "merge-base")).toBe(false);
  expect(seen[0]).toEqual(["for-each-ref", "--format=%(refname:strip=2)", "refs/tags/v*"]);
  await expect(latestRelease(git(tags, 128))).rejects.toThrow("无法读取发布标签");
  await expect(latestRelease(git("v1.2.3\n"))).rejects.toThrow("无法解析发布 v1.2.3 的提交");
});

test("安装说明检出当前版本的正式发布并建立本地 main", async () => {
  const version = JSON.parse(await readFile(`${project}package.json`, "utf8")).version as string;
  for (const name of ["README.md", "docs/deployment.md"]) {
    const text = await readFile(`${project}${name}`, "utf8"), clones = text.match(/^git clone .*$/gm) ?? [];
    expect(clones.length, name).toBeGreaterThan(0);
    for (const clone of clones) expect(clone, name).toStartWith(`git clone --branch v${version} https://github.com/jaykwok/mixin-bot.git`);
    expect(text.split(/\r?\n/).filter(line => line === "git switch -c main").length, name).toBe(clones.length);
  }
});
