import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { undeployed } from "../../console/server/recovery.ts";
import { upgradeRoutes } from "../../console/server/upgrade-routes.ts";
import { DATA_VERSION } from "../../src/core/version.ts";
import type { RouteContext } from "../../console/server/routes.ts";
import { tempFixture } from "../helpers/temp.ts";

const context = (body: unknown = {}): RouteContext => ({ body, signal: new AbortController().signal, session: {} as RouteContext["session"] });

const record = JSON.stringify({ dataVersion: DATA_VERSION, appVersion: "2.0.0", build: "", transaction: "deploy-fixture", application: "a".repeat(64) });

test("尚未部署：没有未完成的事务、部署记录和运行数据；重部署设置指向首次部署", async () => {
  const f = await tempFixture("redeploy-fresh-");
  try {
    const routes = upgradeRoutes(f.root, async () => { throw new Error("尚未部署时不应读取 Git"); });
    const get = () => routes["GET /api/lifecycle/deploy"]!.run(context());
    expect(undeployed(f.root)).toBe(true);
    await expect(get()).rejects.toThrow("尚未部署：重新部署只用于已有实例");
    // Settings written before the first deployment do not make it a deployment.
    mkdirSync(join(f.root, "data/state"), { recursive: true }); writeFileSync(join(f.root, "data/state/bot-port"), "12011");
    expect(undeployed(f.root)).toBe(true);
    await expect(get()).rejects.toThrow("尚未部署");
    // Runtime data without a record, a damaged record, or an unreadable transaction is not a fresh checkout.
    mkdirSync(join(f.root, "data/conversations"));
    expect(undeployed(f.root)).toBe(false);
    rmSync(join(f.root, "data/conversations"), { recursive: true });
    writeFileSync(join(f.root, "data/state/data-version.json"), "{");
    expect(undeployed(f.root)).toBe(false);
    rmSync(join(f.root, "data/state/data-version.json"));
    writeFileSync(join(f.root, "data/state/deploy-transaction"), "corrupt");
    expect(undeployed(f.root)).toBe(false);
    rmSync(join(f.root, "data/state/deploy-transaction"));
    writeFileSync(join(f.root, "data/state/data-version.json"), record);
    expect(undeployed(f.root)).toBe(false);
  } finally { await f.cleanup(); }
});

test("重部署设置来自状态文件，读取不联网；损坏和未完成事务阻止填写旧默认值", async () => {
  const f = await tempFixture("redeploy-settings-");
  try {
    mkdirSync(join(f.root, "data/state"), { recursive: true });
    writeFileSync(join(f.root, "data/state/data-version.json"), record);
    writeFileSync(join(f.root, "data/state/bot-port"), "12011\n"); writeFileSync(join(f.root, "data/state/workspace-root"), "");
    const routes = upgradeRoutes(f.root, async argv => {
      expect(argv).toEqual(["git", "-C", f.root, "rev-parse", "--abbrev-ref", "HEAD"]);
      return { code: 0, stdout: "main", stderr: "" };
    });
    const get = () => routes["GET /api/lifecycle/deploy"]!.run(context());
    expect(await get()).toMatchObject({ port: 12011, workspace: "", hasDirectory: false });
    writeFileSync(join(f.root, "data/state/bot-port"), "oops"); await expect(get()).rejects.toThrow("无法读取");
    writeFileSync(join(f.root, "data/state/bot-port"), "12011");
    writeFileSync(join(f.root, "data/state/workspace-root"), "relative"); await expect(get()).rejects.toThrow("无法读取");
    writeFileSync(join(f.root, "data/state/workspace-root"), f.root); expect(await get()).toMatchObject({ workspace: f.root });
    writeFileSync(join(f.root, "data/state/deploy-transaction"), "corrupt"); await expect(get()).rejects.toThrow("无法读取");
  } finally { await f.cleanup(); }
});
test("检查版本只在明确请求时拉取发布标签，目标是最新的正式发布；网络失败、未知参数和并发检查拒绝", async () => {
  const f = await tempFixture("upgrade-version-");
  const commands: string[][] = [], target = "b".repeat(40);
  let network = true, unblock: (() => void) | undefined, wait = false;
  const deploy = (appVersion: string, transaction = "deploy-fixture") => writeFileSync(join(f.root, "data/state/data-version.json"),
    JSON.stringify({ ...JSON.parse(record), appVersion, transaction }));
  // Only stable vX.Y.Z tags count, compared by number; pre-releases, leading zeros and other names are not releases.
  let tags = "v1.0.0\nv2.0.9\nv2.0.10\nv2.1.0-rc.1\nv02.3.0\nv3.0\nvnext\n";
  try {
    mkdirSync(join(f.root, "data/state"), { recursive: true }); deploy("2.0.9");
    // A newer checkout does not make an older deployment up to date.
    writeFileSync(join(f.root, "package.json"), '{"version":"9.0.0"}');
    const routes = upgradeRoutes(f.root, async (argv, env) => {
      commands.push(argv);
      if (argv[3] === "fetch") {
        expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
        if (wait) await new Promise<void>(resolve => { unblock = resolve; });
        return { code: network ? 0 : 1, stdout: "", stderr: "synthetic-secret-in-remote" };
      }
      if (argv[3] === "show") return { code: 0, stdout: '{"protocol":"mixin-console-lifecycle","version":1}', stderr: "" };
      if (argv[3] === "for-each-ref") return { code: 0, stdout: tags, stderr: "" };
      if (argv.includes("refs/tags/v2.0.10^{commit}")) return { code: 0, stdout: target, stderr: "" };
      throw new Error("Unexpected git command: " + argv.join(" "));
    });
    expect(await routes["GET /api/lifecycle/upgrade"]!.run(context())).toEqual({ current: "2.0.9", hasDirectory: false });
    expect(commands).toEqual([]);
    expect(commands.some(argv => argv[3] === "fetch")).toBe(false);
    await expect(routes["POST /api/lifecycle/check-update"]!.run(context({ remote: "evil" }))).rejects.toThrow("未允许");
    expect(commands.some(argv => argv[3] === "fetch")).toBe(false);
    network = false;
    await expect(routes["POST /api/lifecycle/check-update"]!.run(context())).rejects.toThrow("检查版本失败");
    network = true;
    mkdirSync(join(f.root, "data/config"), { recursive: true }); writeFileSync(join(f.root, "data/config/directory.json"), '{"format":1,"all":true}');
    expect(await routes["POST /api/lifecycle/check-update"]!.run(context())).toEqual({ current: "2.0.9", hasDirectory: true, available: true, target, release: "v2.0.10" });
    expect(commands.filter(argv => argv[3] === "fetch")).toEqual(Array(2).fill(["git", "-C", f.root, "fetch", "--prune", "--no-tags", "origin", "+refs/tags/v*:refs/tags/v*"]));
    // Equal and newer installed versions are up to date, irrespective of branches or ancestry.
    for (const current of ["2.0.10", "2.1.0"]) {
      deploy(current);
      expect(await routes["POST /api/lifecycle/check-update"]!.run(context())).toEqual({ current, hasDirectory: true, available: false, release: "v2.0.10" });
    }
    expect(commands.some(argv => argv[3] === "merge-base" || argv.includes("--abbrev-ref"))).toBe(false);
    tags = "v2.1.0-rc.1\nvnext\n";
    await expect(routes["POST /api/lifecycle/check-update"]!.run(context())).rejects.toThrow("远端没有正式发布");
    tags = "v2.0.10\n";
    wait = true; const pending = routes["POST /api/lifecycle/check-update"]!.run(context());
    while (!unblock) await Bun.sleep(1);
    await expect(routes["POST /api/lifecycle/check-update"]!.run(context())).rejects.toThrow("正在检查版本");
    unblock!(); await pending;
    // A same-version redeployment during the fetch still invalidates the check.
    unblock = undefined;
    const changing = routes["POST /api/lifecycle/check-update"]!.run(context());
    while (!unblock) await Bun.sleep(1);
    deploy("2.1.0", "deploy-replaced");
    (unblock as () => void)();
    await expect(changing).rejects.toThrow("部署状态已变化");
  } finally { unblock?.(); await f.cleanup(); }
});
