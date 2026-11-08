#!/usr/bin/env bun
// macOS, started as root by the ops entry: runs one interactive command as another account, on the caller's terminal. The
// identity is dropped here (setgroups, setgid, setuid, then setuid(0) must fail), never through sudo or the environment.
// Unattended data steps use the supervised path instead (ProcessOptions.identity), which also reaps what the command leaves.
// Callers build the command with becomeCommand (launchd-host.ts): this process starts with a neutral environment and passes
// the command its own one, MIXIN_BECOME_ENV.
// Usage: bun macos-become.ts <uid> <gid> -- <command> [arguments...]
import { dropIdentity } from "../../src/lib/darwin.ts";

const [uid, gid, separator, command, ...args] = process.argv.slice(2);
const id = (text: string | undefined) => text !== undefined && /^\d{1,10}$/.test(text) ? Number(text) : NaN;
let env: Record<string, string> | undefined;
try { env = JSON.parse(process.env.MIXIN_BECOME_ENV ?? ""); } catch { env = undefined; }
if (process.platform !== "darwin" || !Number.isSafeInteger(id(uid)) || !Number.isSafeInteger(id(gid)) || separator !== "--" || !command
  || !env || typeof env !== "object" || Array.isArray(env) || !Object.values(env).every(value => typeof value === "string")) {
  console.error("用法：bun macos-become.ts <uid> <gid> -- <命令> [参数...]，命令的环境在 MIXIN_BECOME_ENV（只用于 macOS）");
  process.exit(2);
}
dropIdentity(id(uid), id(gid));
const child = Bun.spawn([command, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
// Ctrl+C reaches the whole foreground group, the command included; a TERM or HANGUP sent only to this process is passed on.
process.on("SIGINT", () => {});
for (const name of ["SIGTERM", "SIGHUP"] as const) process.on(name, () => child.kill(name));
const code = await child.exited;
process.exit(child.signalCode ? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[child.signalCode as string] ?? 0) : code);
