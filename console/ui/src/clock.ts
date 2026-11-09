// The console server's clock as this page knows it. Session answers carry the server's time; deadlines the server sets
// (the session's expiry, a preview's) are compared with it, so a computer whose clock is off neither ends a valid session
// early nor shows a valid preview as expired.
//
// The server read its clock somewhere between the request leaving and the answer arriving: the middle of the two is the
// estimate, off by at most half the round trip. A login's answer always sets it, however slow: the page has no estimate
// before it (this computer's own clock may be off by any amount) and the shell opens on it. A later answer (session polls,
// renewals) replaces it only when its round trip is within ROUND_TRIP_MS, so a slow one cannot make it rougher. Callers
// also drop answers to requests of an earlier login (app.tsx): the offset is shared by the whole tab.
const ROUND_TRIP_MS = 10_000;
let offset = 0;

/** Takes the server's time from an answer that carries it; `sentAt` and `receivedAt` are this computer's Date.now(). */
export function adoptServerTime(serverNow: number, sentAt: number, { login = false, receivedAt = Date.now() } = {}): void {
  const trip = receivedAt - sentAt;
  if (!login && (trip < 0 || trip > ROUND_TRIP_MS)) return;
  // This computer's clock went back meanwhile: only the arrival is on the clock the page reads from now on.
  offset = serverNow - (trip < 0 ? receivedAt : (sentAt + receivedAt) / 2);
}

/** The server's time at `local` (this computer's Date.now()). */
export const serverTime = (local = Date.now()): number => local + offset;
