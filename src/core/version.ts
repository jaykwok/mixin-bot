// The one source of the program's version facts. Built-ins only: usable before runtime.json is valid.
import manifest from "../../package.json";

/** Program version (package.json of the running code): shown in the console and the basis of release and upgrade decisions. */
export const APP_VERSION: string = manifest.version;

/**
 * Data format version: whether this program can open the existing databases and directories. It changes only with the
 * storage format, not with every release.
 *
 * 3: application-shared workspace, per-space conversation databases under data/conversations, data/tmp,
 * data/state/stats.sqlite, and the state database with the push tables as src/push/store.ts creates them. Deployments of
 * earlier formats are not upgraded: deploy fresh and restore the statistics.
 */
export const DATA_VERSION = 3;

/**
 * Build identity: the commit the running code was built from, `-dirty` when built from a modified working tree. Set by
 * the image build (Docker ARG) or the Windows launcher; empty when the code runs straight from a checkout.
 */
export const APP_BUILD: string = process.env.APP_BUILD?.trim() ?? "";
