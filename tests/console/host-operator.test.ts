import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { asOperator, checkoutOwner } from "../../console/server/host-operator.ts";

test("检出属主：只有 root 控制台且属主不是 root 时才切换；Linux 账户信息取自 getent，读不到就拒绝", async () => {
  const calls: string[][] = [];
  const run = (stdout: string, code = 0) => async (argv: string[]) => { calls.push(argv); return { code, stdout, stderr: "" }; };
  const entry = "owner:x:1000:1001:Owner:/home/owner:/bin/bash\n";
  expect(await checkoutOwner("/srv/bot", "win32", 0, run(entry), () => 1000)).toBeNull();
  expect(await checkoutOwner("/srv/bot", "linux", 1000, run(entry), () => 1000)).toBeNull();
  expect(await checkoutOwner("/srv/bot", "linux", 0, run(entry), () => 0)).toBeNull();
  expect(calls).toEqual([]);
  expect(await checkoutOwner("/srv/bot", "linux", 0, run(entry), () => 1000))
    .toEqual({ uid: 1000, gid: 1001, env: { HOME: "/home/owner", USER: "owner", LOGNAME: "owner" } });
  expect(calls).toEqual([["getent", "passwd", "1000"]]);
  for (const bad of [run("", 2), run("owner:x:1002:1001:Owner:/home/owner:/bin/bash"), run("owner:x:1000:x:Owner:/home/owner:/bin/bash"), run("owner:x:1000:1001:Owner:relative:/bin/sh")])
    await expect(checkoutOwner("/srv/bot", "linux", 0, bad, () => 1000)).rejects.toThrow("UID 1000");
});

test("以属主运行：Linux 经 setpriv 并带属主的 HOME；没有属主时命令和环境原样", () => {
  const owner = { uid: 1000, gid: 1001, env: { HOME: "/home/owner", USER: "owner", LOGNAME: "owner" } };
  expect(asOperator("win32", null, ["bun", "install"], {})).toEqual({ command: "bun", args: ["install"], env: {} });
  const linux = asOperator("linux", owner, ["/usr/local/bin/bun", "install"]);
  expect(linux.command).toBe("setpriv");
  expect(linux.args).toEqual(["--reuid=1000", "--regid=1001", "--init-groups", "--", "/usr/local/bin/bun", "install"]);
  expect(linux.env).toMatchObject(owner.env);
  expect(linux.env.PATH!.startsWith(dirname(process.execPath) + ":")).toBe(true);
});
