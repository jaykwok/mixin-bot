// Protocol limits shared by runtime requests and side-effect-free configuration validation.
/** Outbound native files share the upload contract; larger files use the relay. */
export { NATIVE_FILE_MAX_BYTES } from "../contracts/transfer-limits.ts";
/** One relay delivery's whole budget (snapshot, waiting for the lock, probes and the PUT); the run and /stop cancel it as well. */
export const RELAY_HTTP_TIMEOUT = 30 * 60_000;
export const RELAY_PROBE_TIMEOUT = 15_000;
