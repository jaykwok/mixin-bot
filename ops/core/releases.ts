// Upgrades follow published releases: the highest stable vX.Y.Z tag of origin, never the tip of a branch. The same rule
// is in scripts/ops.sh (latest_release) and scripts/ops.ps1 (Get-LatestRelease).

/** Mirrors origin's release tags: one moved or deleted there is moved or deleted here, so the choice is always origin's. */
export const RELEASE_FETCH = ["fetch", "--prune", "--no-tags", "origin", "+refs/tags/v*:refs/tags/v*"];
// Up to nine digits a part, as in the shell entries (PowerShell compares them as Int32).
const STABLE = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const newer = (a: number[], b: number[]) => {
  const index = a.findIndex((part, at) => part !== b[at]);
  return index >= 0 && a[index]! > b[index]!;
};

type Git = (args: string[]) => Promise<{ code: number; stdout: string }>;
export interface Release { tag: string; commit: string; /** Local main already contains it and more: nothing to upgrade to. */ behind: boolean }

/** The latest release among the local tags, read after RELEASE_FETCH. Throws when there is none or it cannot be read. */
export async function latestRelease(git: Git): Promise<Release> {
  const listed = await git(["for-each-ref", "--format=%(refname:strip=2)", "refs/tags/v*"]);
  if (listed.code !== 0) throw new Error("无法读取发布标签");
  let tag = "", best: number[] = [];
  for (const name of listed.stdout.split(/\r?\n/).map(line => line.trim())) {
    const parts = STABLE.exec(name)?.slice(1).map(Number);
    if (parts && (!tag || newer(parts, best))) { tag = name; best = parts; }
  }
  if (!tag) throw new Error("远端没有正式发布（vX.Y.Z 标签），无法升级");
  const commit = (await git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`])).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`无法解析发布 ${tag} 的提交`);
  const main = await git(["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]), local = main.stdout.trim();
  const behind = main.code === 0 && local !== commit && (await git(["merge-base", "--is-ancestor", commit, local])).code === 0;
  return { tag, commit, behind };
}
