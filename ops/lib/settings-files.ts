// The instance's settings files: where each lives, who writes it, whether it holds credentials, what checks it, and which
// deployment snapshots save it. The deployment snapshots and the redeploy preconditions read this list; the shell and
// PowerShell entries keep their own copies, which tests/contracts/settings-files.test.ts compares with it.

export type SnapshotPlatform = "docker" | "windows" | "macos";
/**
 * configuration: the wizards and the console, through the configuration transaction; pi: Pi itself (model selection and
 * catalogue); deployment: the deployment core; console: the console through the running service (the directory scope,
 * the materials exclusions); operator: edited by hand.
 */
export type SettingsWriter = "configuration" | "pi" | "deployment" | "console" | "operator";

export interface SettingsFile {
  /** Project-relative, forward slashes. */
  readonly path: string;
  readonly writers: readonly SettingsWriter[];
  /** Holds credentials: never shown in the console, logs or diagnostics. */
  readonly secret: boolean;
  /** What reads and validates it before the service starts, or why nothing does. */
  readonly check: string;
  /** Created by the first deployment; a redeployment or upgrade without it is refused before anything stops. */
  readonly required: boolean;
  /** Platforms whose deployment snapshot saves it and whose rollback restores it. */
  readonly snapshot: readonly SnapshotPlatform[];
}

const ALL: readonly SnapshotPlatform[] = ["docker", "windows", "macos"];

// data/config is saved and restored as a whole directory, so every file in it is in every snapshot. Providers, model
// selection and the dynamic catalogue restore together, so a rolled-back instance still resolves its model offline.
export const SETTINGS_FILES: readonly SettingsFile[] = [
  { path: "data/config/models.json", writers: ["configuration"], secret: true, check: "Pi model configuration (openModelRuntime)", required: true, snapshot: ALL },
  { path: "data/config/app-bot.json", writers: ["configuration"], secret: true, check: "readAppBotConfig, bound to the deployment record", required: true, snapshot: ALL },
  { path: "data/config/runtime.json", writers: ["configuration", "deployment"], secret: false, check: "validateRuntimeConfig", required: false, snapshot: ALL },
  { path: "data/config/relay.json", writers: ["configuration"], secret: true, check: "readRelayConfigFile; absent disables relay", required: false, snapshot: ALL },
  { path: "data/config/auxiliary.json", writers: ["configuration"], secret: false, check: "readAuxiliaryConfig, models resolved against models.json", required: false, snapshot: ALL },
  { path: "data/config/mcp.json", writers: ["operator"], secret: true, check: "readMcpConfig", required: false, snapshot: ALL },
  { path: "data/config/directory.json", writers: ["deployment", "console"], secret: false, check: "readDirectoryScope", required: false, snapshot: ALL },
  { path: "data/config/task-deployment.json", writers: ["deployment"], secret: false, check: "Linux task isolation: the Docker host reads it", required: false, snapshot: ALL },
  { path: "data/config/materials-ignore.txt", writers: ["operator", "console"], secret: false, check: "none: the materials index reads it as exclusion rules", required: false, snapshot: ALL },
  { path: "data/runtime/pi/settings.json", writers: ["pi"], secret: false, check: "resolveModelSelection", required: true, snapshot: ALL },
  { path: "data/runtime/models-store.json", writers: ["pi"], secret: false, check: "Pi catalogue cache; may be absent", required: false, snapshot: ALL },
  { path: "data/runtime/bot-launcher.ps1", writers: ["deployment"], secret: false, check: "none: generated from the recorded tools", required: false, snapshot: ["windows"] },
  { path: "data/state/bot-port", writers: ["deployment"], secret: false, check: "port syntax, read by the entries and the core", required: false, snapshot: ALL },
  { path: "data/state/workspace-root", writers: ["deployment"], secret: false, check: "checkProjectLayout", required: false, snapshot: ALL },
  { path: "data/state/task-runtime", writers: ["deployment"], secret: false, check: "the Docker host's task runtime record", required: false, snapshot: ["docker"] },
];

/** What a deployment snapshot saves on `platform`, in order: data/config as one directory, then the files outside it. */
export function snapshotPaths(platform: SnapshotPlatform): string[] {
  const paths = SETTINGS_FILES.filter(file => file.snapshot.includes(platform)).map(file => file.path.startsWith("data/config/") ? "data/config" : file.path);
  return [...new Set(paths)];
}

/** Settings a redeployment or upgrade requires, in the order the entries check them. */
export const REQUIRED_SETTINGS = SETTINGS_FILES.filter(file => file.required).map(file => file.path);
