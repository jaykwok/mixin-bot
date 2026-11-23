import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
  createMcpAuthProvider,
  McpOAuthAuthorizationRequiredError,
  McpRefreshLockBusyError,
  type McpAuthProvider,
  type McpOAuthClientOptions,
  type McpOAuthServerStore,
  type McpOAuthSettings,
  type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { AsyncSemaphore } from "../core/async-semaphore.ts";
import { expandVariables, type McpServerConfig } from "../core/mcp-config.ts";
import { replaceFile } from "../core/maintenance.ts";

const DEFAULT_OAUTH_STATE_ROOT = "data/runtime/mcp";
/** A refresh lock whose holder died without releasing is taken over after this. */
const REFRESH_LOCK_STALE_MS = 20_000;
/** How long to wait for another process's refresh: longer than a stale lock lives. */
const REFRESH_LOCK_WAIT_MS = 25_000;
const REFRESH_LOCK_RETRY_MS = 100;

/** In-process serialization per lock target so concurrent instances sharing a stateRoot wait in order before locking disk. */
const processRefreshLocks = new Map<string, AsyncSemaphore>();

function processLockFor(target: string): AsyncSemaphore {
  let lock = processRefreshLocks.get(target);
  if (!lock) {
    lock = new AsyncSemaphore(1);
    processRefreshLocks.set(target, lock);
  }
  return lock;
}

function assertOAuthServer(server: McpServerConfig): { url: string; oauth: NonNullable<McpServerConfig["oauth"]> } {
  if (!server.oauth || !server.url) throw new Error("服务器未配置 OAuth");
  return { url: server.url, oauth: server.oauth };
}

function mcpOAuthSettings(server: McpServerConfig): McpOAuthSettings {
  const { oauth } = assertOAuthServer(server);
  let clientSecret: string | undefined;
  try { clientSecret = oauth.clientSecret === undefined ? undefined : expandVariables(oauth.clientSecret); }
  catch (error) { throw new Error(`MCP ${server.name} 的 OAuth 密钥：${(error as Error).message}`); }
  return {
    ...(oauth.clientId ? { clientId: oauth.clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    callbackPort: oauth.callbackPort,
    ...(oauth.scope ? { scope: oauth.scope } : {}),
    ...(oauth.clientName ? { clientName: oauth.clientName } : {}),
    // mixin-bot does not publish Client ID Metadata Documents; use pre-registered clientId or dynamic client registration.
    clientRegistration: "dcr",
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await replaceFile(temporary, path);
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

type ChallengeHandler = Parameters<typeof createMcpAuthProvider>[0]["onChallenge"];
export type McpOAuthChallenge = Parameters<ChallengeHandler>[0];

interface StoredOAuthChallenge {
  serverUrl: string;
  error?: string;
  scope?: string;
  resourceMetadataUrl?: string;
  errorDescription?: string;
  at: number;
}

function challengePathOf(server: McpServerConfig, stateRoot = DEFAULT_OAUTH_STATE_ROOT): string {
  return join(stateRoot, `${server.name}.challenge.json`);
}

function serializeChallenge(expectedUrl: string, challenge: McpOAuthChallenge): StoredOAuthChallenge {
  return {
    serverUrl: expectedUrl,
    ...(challenge.error ? { error: challenge.error } : {}),
    ...(challenge.scope ? { scope: challenge.scope } : {}),
    ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl.href } : {}),
    ...(challenge.errorDescription ? { errorDescription: challenge.errorDescription } : {}),
    at: Date.now(),
  };
}

/**
 * Load the last persisted WWW-Authenticate challenge for this server (e.g., `insufficient_scope` with requested scope),
 * scoped strictly to the exact normalized `serverUrl`. Returns undefined when absent or belonging to another URL.
 */
export async function loadPendingMcpChallenge(server: McpServerConfig, stateRoot = DEFAULT_OAUTH_STATE_ROOT): Promise<McpOAuthChallenge | undefined> {
  const { url } = assertOAuthServer(server);
  const expectedUrl = String(new URL(url));
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(challengePathOf(server, stateRoot), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const stored = parsed as Partial<StoredOAuthChallenge>;
  if (stored.serverUrl !== expectedUrl) return undefined;
  let resourceMetadataUrl: URL | undefined;
  if (typeof stored.resourceMetadataUrl === "string") {
    try { resourceMetadataUrl = new URL(stored.resourceMetadataUrl); } catch {}
  }
  return {
    ...(typeof stored.error === "string" ? { error: stored.error } : {}),
    ...(typeof stored.scope === "string" ? { scope: stored.scope } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(typeof stored.errorDescription === "string" ? { errorDescription: stored.errorDescription } : {}),
  };
}

/** Remove any stored pending challenge for this server after sign-in or successful refresh. */
export async function clearPendingMcpChallenge(server: McpServerConfig, stateRoot = DEFAULT_OAUTH_STATE_ROOT): Promise<void> {
  await unlink(challengePathOf(server, stateRoot)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

/**
 * Per-server OAuth state store under `stateRoot`:
 * - Scopes persisted credentials strictly to the exact normalized `serverUrl` (even when `createMcpAuthProvider.token()`
 *   reads `store.load()` directly).
 * - Atomic `0o600` file writes via `fsync` + `replaceFile`.
 * - In-process + cross-process (`proper-lockfile`) refresh lock preventing concurrent refresh-token rotation races.
 */
export function mcpOAuthStore(server: McpServerConfig, stateRoot = DEFAULT_OAUTH_STATE_ROOT): McpOAuthServerStore {
  const { url } = assertOAuthServer(server);
  const expectedUrl = String(new URL(url));
  const path = join(stateRoot, `${server.name}.json`);
  const hash = createHash("sha256").update(`${server.name}|${expectedUrl}`).digest("hex").slice(0, 12);
  const lockTarget = resolve(stateRoot, `${server.name}-${hash}.refresh`);

  return {
    async load(): Promise<McpOAuthState | undefined> {
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(path, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      const state = parsed as McpOAuthState;
      return state.serverUrl === expectedUrl ? state : undefined;
    },

    async save(state: McpOAuthState): Promise<void> {
      const persisted: McpOAuthState = { ...state, serverUrl: expectedUrl };
      await writePrivateJson(path, persisted);
    },

    async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
      const releaseProcess = await processLockFor(lockTarget).acquire();
      try {
        await mkdir(dirname(lockTarget), { recursive: true, mode: 0o700 });
        const releaseFile = await lockfile.lock(lockTarget, {
          realpath: false,
          stale: REFRESH_LOCK_STALE_MS,
          retries: {
            retries: REFRESH_LOCK_WAIT_MS / REFRESH_LOCK_RETRY_MS,
            factor: 1,
            minTimeout: REFRESH_LOCK_RETRY_MS,
            maxTimeout: REFRESH_LOCK_RETRY_MS,
          },
          onCompromised: () => {},
        }).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ELOCKED") {
            throw new McpRefreshLockBusyError();
          }
          throw error;
        });
        try { return await fn(); }
        finally { await releaseFile().catch(() => {}); }
      } finally { releaseProcess(); }
    },
  };
}

/** OAuth client options for interactive administrator sign-in (`startMcpSignIn` / `completeMcpSignIn`). */
export function mcpOAuthClient(server: McpServerConfig, stateRoot = DEFAULT_OAUTH_STATE_ROOT): McpOAuthClientOptions {
  const { url, oauth } = assertOAuthServer(server);
  return {
    serverUrl: url,
    store: mcpOAuthStore(server, stateRoot),
    settings: mcpOAuthSettings(server),
    clientName: oauth.clientName ?? "mixin-bot",
  };
}

function mergeScopeStrings(existing: string | undefined, incoming: string | undefined): string | undefined {
  const merged = [...new Set([...(existing?.split(/\s+/) ?? []), ...(incoming?.split(/\s+/) ?? [])].filter(Boolean))];
  return merged.length > 0 ? merged.join(" ") : undefined;
}

/**
 * `McpOAuthAuthorizationRequiredError` enriched with the captured `WWW-Authenticate` challenge and any failure to
 * persist that challenge to disk, so callers can still emit an actionable recovery command (`--scope` / `--reauth`).
 */
export class McpOAuthAuthorizationDetailError extends McpOAuthAuthorizationRequiredError {
  constructor(
    readonly challenge: McpOAuthChallenge,
    readonly persistError?: Error,
    cause?: unknown,
  ) {
    super();
    this.name = "McpOAuthAuthorizationDetailError";
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Persist a failed authorization challenge without losing an earlier unresolved `insufficient_scope` step-up.
 * Serialized per challenge file; scopes are merged so multiple under-scoped tools accumulate cleanly.
 * Never swallows disk-write errors: returns the merged challenge alongside any `persistError` for operator reporting.
 */
async function recordPendingMcpChallenge(server: McpServerConfig, expectedUrl: string, incoming: McpOAuthChallenge, stateRoot: string): Promise<{ challenge: McpOAuthChallenge; persistError?: Error }> {
  const path = resolve(challengePathOf(server, stateRoot));
  const release = await processLockFor(path).acquire();
  try {
    const existing = await loadPendingMcpChallenge(server, stateRoot).catch(() => undefined);
    const keepStepUp = existing?.error === "insufficient_scope" || incoming.error === "insufficient_scope";
    const mergedScope = mergeScopeStrings(existing?.scope, incoming.scope);
    const resourceMetadataUrl = incoming.resourceMetadataUrl ?? existing?.resourceMetadataUrl;
    const errorDescription = incoming.error === "insufficient_scope"
      ? (incoming.errorDescription ?? existing?.errorDescription)
      : (existing?.error === "insufficient_scope" ? existing.errorDescription : incoming.errorDescription);
    const merged: McpOAuthChallenge = {
      ...(keepStepUp ? { error: "insufficient_scope" } : incoming.error ? { error: incoming.error } : existing?.error ? { error: existing.error } : {}),
      ...(mergedScope ? { scope: mergedScope } : {}),
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(errorDescription ? { errorDescription } : {}),
    };
    try {
      await writePrivateJson(path, serializeChallenge(expectedUrl, merged));
      return { challenge: merged };
    } catch (error) {
      return { challenge: merged, persistError: error instanceof Error ? error : new Error(String(error)) };
    }
  } finally {
    release();
  }
}

/**
 * Runtime auth provider built with `@earendil-works/pi-mcp/oauth`'s `createMcpAuthProvider`:
 * sends stored tokens, refreshes proactively near expiry or on 401 with single-flight + file-locked rotation safety,
 * persists `WWW-Authenticate` challenges per call (such as `insufficient_scope`) without allowing an unrelated 401
 * recovery to erase an unresolved step-up requirement, and never starts a browser flow during service runtime.
 */
export function mcpAuthProvider(server: McpServerConfig, options: {
  stateRoot?: string;
  onChallenge?: ChallengeHandler;
} = {}): McpAuthProvider {
  const { url, oauth } = assertOAuthServer(server);
  const expectedUrl = String(new URL(url));
  const stateRoot = options.stateRoot ?? DEFAULT_OAUTH_STATE_ROOT;
  let activeCapture: ((challenge: McpOAuthChallenge) => void) | undefined;
  const inner = createMcpAuthProvider({
    serverUrl: url,
    store: mcpOAuthStore(server, stateRoot),
    settings: () => mcpOAuthSettings(server),
    clientName: oauth.clientName ?? "mixin-bot",
    redirectUrl: `http://127.0.0.1:${oauth.callbackPort}/callback`,
    onChallenge: (challenge) => {
      options.onChallenge?.(challenge);
      activeCapture?.(challenge);
    },
  });
  return {
    token: () => inner.token(),
    onUnauthorized: async (context) => {
      // `createMcpAuthProvider.onUnauthorized` invokes `onChallenge` synchronously before its first await;
      // binding via a per-call local avoids cross-request interference when 403 and 401 calls overlap.
      let callChallenge: McpOAuthChallenge | undefined;
      activeCapture = (challenge) => { callChallenge = challenge; };
      let pending: Promise<void> | undefined;
      try {
        pending = inner.onUnauthorized?.(context);
      } finally {
        activeCapture = undefined;
      }
      try {
        await pending;
        // Never clear a pending `insufficient_scope` challenge here: an ordinary 401 refresh only preserves the
        // existing scope; only interactive login (`bun run mcp login`) resolves and clears step-up challenges.
      } catch (error) {
        if (callChallenge && (callChallenge.error === "insufficient_scope" || callChallenge.scope || callChallenge.resourceMetadataUrl)) {
          const { challenge, persistError } = await recordPendingMcpChallenge(server, expectedUrl, callChallenge, stateRoot);
          if (error instanceof McpOAuthAuthorizationRequiredError) {
            throw new McpOAuthAuthorizationDetailError(challenge, persistError, error);
          }
        }
        throw error;
      }
    },
    settled: () => inner.settled(),
  };
}
