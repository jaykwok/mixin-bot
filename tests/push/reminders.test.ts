// The progress moments of a push (src/push/reminders.ts): none for a short one, half way for one within a day, half way
// and shortly before the deadline for a longer one; never at night, and apart from the start, the deadline and each other.
import { expect, test } from "bun:test";
import { checkpoints } from "../../src/push/reminders.ts";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const shown = (times: number[]) => times.map(time => { const d = new Date(time); return `${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; });

test("a push shorter than two hours has no moment; one within a day has one, half way", () => {
  expect(checkpoints(at(3, 9), at(3, 10, 59))).toEqual([]);
  expect(shown(checkpoints(at(3, 9), at(3, 11)))).toEqual(["3 10:00"]);
  expect(shown(checkpoints(at(3, 9), at(3, 15)))).toEqual(["3 12:00"]);
  expect(shown(checkpoints(at(3, 9), at(4, 8, 59)))).toEqual(["3 20:59"]);
});

test("a day or more: half way, and an eighth of the run before the deadline (three hours at least, a day at most)", () => {
  expect(shown(checkpoints(at(3, 20), at(4, 20)))).toEqual(["4 08:00", "4 17:00"]);
  // Only a date was given (23:59): both by day.
  expect(shown(checkpoints(at(3, 9), at(5, 23, 59)))).toEqual(["4 16:29", "5 16:06"]);
  // Thirty days: the second is a day before the end.
  expect(shown(checkpoints(at(1, 10), at(1, 10) + 30 * 24 * 3600_000))).toEqual(["16 10:00", "30 10:00"]);
});

test("a moment at night moves to the next morning, or to the evening before when the morning is too late", () => {
  // Half way at 03:00, the second at 06:00: both at 08:00 of their days.
  expect(shown(checkpoints(at(3, 15), at(6, 15)))).toEqual(["5 08:00", "6 08:00"]);
  // Three days from 09:00: the second would be at midnight, and 08:00 is still an hour before the deadline.
  expect(shown(checkpoints(at(3, 9), at(6, 9)))).toEqual(["4 21:00", "6 08:00"]);
  // A day from 10:00: the second moves from 07:00 to 08:00, so the first (22:00) cannot wait for the morning: the evening before.
  expect(shown(checkpoints(at(3, 10), at(4, 10)))).toEqual(["3 21:00", "4 08:00"]);
  // The morning is past the deadline and the evening before the start: nothing.
  expect(checkpoints(at(3, 23), at(4, 1))).toEqual([]);
  // A day from 03:00 until 03:00: the second moment (midnight) cannot wait for the morning either: the evening before.
  expect(shown(checkpoints(at(3, 3), at(4, 3)))).toEqual(["3 15:00", "3 21:00"]);
});
