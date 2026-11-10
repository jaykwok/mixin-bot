// The checkout's node_modules that the console installed before the first deployment (setup-routes.ts), marked in .console.
// Linux Docker hosts keep their dependencies in the image: once deployed, the console removes its node_modules there again, so
// the ops entry never runs on packages that upgrades would leave behind. Windows and macOS run the checkout itself and keep
// it; only the marker goes. Settled after a successful first deployment and, should that fail midway, at the next start.
import { lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { consoleDir } from "../../ops/core/console-state.ts";

/** .console/<this>: the console created the checkout's node_modules before the first deployment. */
export const CREATED_DEPENDENCIES = "host-dependencies.json";

/** Call only once the checkout is deployed. A link or file in node_modules' place is not what the console installed and stays. */
export function settleCreatedDependencies(project: string, platform: NodeJS.Platform = process.platform): void {
  const marker = join(consoleDir(project), CREATED_DEPENDENCIES);
  try { lstatSync(marker); } catch { return; }
  if (platform === "linux") {
    let stat: ReturnType<typeof lstatSync> | undefined;
    try { stat = lstatSync(join(project, "node_modules")); } catch { /* Already gone. */ }
    if (stat?.isDirectory() && !stat.isSymbolicLink()) rmSync(join(project, "node_modules"), { recursive: true, force: true });
  }
  rmSync(marker, { force: true });
}
