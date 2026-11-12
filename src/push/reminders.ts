// When a push that went out looks at its progress: the pusher is told how it stands, and unless the pusher turned that
// off the card goes once more to whoever has not answered (./service.ts). At most twice per push, never at night.

const REMINDERS = {
  /** A push that runs shorter than this has no such moment. */
  minSpanMs: 2 * 3600_000,
  /** One that runs at least this long has two: half way, and shortly before the deadline. Shorter ones only the first. */
  twiceSpanMs: 24 * 3600_000,
  /** The moments keep this far from the start, from the deadline and from each other. */
  gapMs: 3600_000,
  /** The second moment is an eighth of the run before the deadline, within these bounds. */
  leadMs: [3 * 3600_000, 24 * 3600_000] as readonly [number, number],
  /** Nothing is sent from `quiet[0]` o'clock to `quiet[1]` o'clock (local time): a moment there moves to the next morning, or else to `evening` o'clock before. */
  quiet: [22, 8] as readonly [number, number],
  evening: 21,
};

/**
 * Whether `at` is in the quiet hours. The moments are never there; one that went by while the service was down waits
 * for the morning rather than sending at night (./service.ts).
 */
export function quietHours(at: number): boolean {
  const hour = new Date(at).getHours(), [from, to] = REMINDERS.quiet;
  return hour >= from || hour < to;
}

/** `at` itself by day; at night the next morning, then the evening before. The first of them within `low` and `high`. */
function awake(at: number, low: number, high: number): number | undefined {
  const date = new Date(at), hour = date.getHours(), [from, to] = REMINDERS.quiet;
  const day = (offset: number, hours: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, hours).getTime();
  const candidates = !quietHours(at) ? [at] : hour >= from ? [day(1, to), day(0, REMINDERS.evening)] : [day(0, to), day(-1, REMINDERS.evening)];
  return candidates.find(each => each >= low && each <= high);
}

/** The moments of a push confirmed at `from` with the deadline `to`, in order: none, one or two, each on a full minute. */
export function checkpoints(from: number, to: number): number[] {
  const span = to - from, { gapMs, leadMs } = REMINDERS;
  if (span < REMINDERS.minSpanMs) return [];
  const last = span < REMINDERS.twiceSpanMs ? undefined : awake(to - Math.min(Math.max(span / 8, leadMs[0]), leadMs[1]), from + 2 * gapMs, to - gapMs);
  const half = awake(from + span / 2, from + gapMs, (last ?? to) - gapMs);
  return [half, last].filter(each => each !== undefined).map(each => each - each % 60_000);
}
