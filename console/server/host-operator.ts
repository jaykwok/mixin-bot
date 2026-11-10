// Before the first deployment the console's helpers run on the host: no image or service account exists yet. A console
// started as root (sudo on Linux rootful Docker and on macOS) runs them as the checkout's owner, so network replies are
// never parsed as root and the dependencies it installs stay the owner's.
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { becomeCommand } from "../../ops/core/launchd-host.ts";
import { checkoutOperator } from "../../ops/core/macos-lifecycle.ts";
import { runCommand, type Runner } from "../../ops/core/hosting.ts";

export interface Operator { uid: number; gid: number; env: Record<string, string> }
export interface OperatorCommand { command: string; args: string[]; env: Record<string, string> }

/** The checkout's owner when this console runs as root and the owner is someone else; null keeps the console's identity. */
export async function checkoutOwner(project: string, platform: NodeJS.Platform = process.platform, euid = process.geteuid?.(),
  run: Runner = runCommand, owner = () => lstatSync(project).uid): Promise<Operator | null> {
  if (platform === "win32" || euid !== 0) return null;
  const uid = owner();
  if (uid === 0) return null;
  if (platform === "darwin") {
    const operator = await checkoutOperator(project, run);
    if (!operator.identity) return null;
    const env = Object.fromEntries(Object.entries(operator.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    return { ...operator.identity, env };
  }
  const entry = await run(["getent", "passwd", String(uid)]), fields = entry.stdout.trim().split(":");
  const gid = Number(fields[3]);
  if (entry.code !== 0 || fields.length < 7 || Number(fields[2]) !== uid || !/^\d+$/.test(fields[3] ?? "") || !Number.isSafeInteger(gid) || !fields[5]?.startsWith("/"))
    throw new Error(`无法读取项目目录属主（UID ${uid}）的账户信息`);
  return { uid, gid, env: { HOME: fields[5], USER: fields[0]!, LOGNAME: fields[0]! } };
}

/**
 * `argv` as `operator`: macOS through macos-become.ts, Linux through setpriv (util-linux). The switched command's PATH
 * starts with the console's own Bun, which must be one the owner can run. Without an operator the environment is the
 * console's own (on Windows a second PATH key beside the inherited Path would shadow it).
 */
export function asOperator(platform: NodeJS.Platform, operator: Operator | null, argv: string[], env: Record<string, string> = {}): OperatorCommand {
  if (!operator) return { command: argv[0]!, args: argv.slice(1), env };
  if (platform === "darwin") {
    const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^SUDO_/.test(entry[0]));
    const become = becomeCommand(operator, argv, { ...Object.fromEntries(inherited), ...env, ...operator.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` });
    return { command: become.argv[0]!, args: become.argv.slice(1), env: become.env };
  }
  return { command: "setpriv", args: [`--reuid=${operator.uid}`, `--regid=${operator.gid}`, "--init-groups", "--", ...argv],
    env: { ...env, ...operator.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}` } };
}
