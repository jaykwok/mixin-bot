// An operator's message in a member's conversation (./takeover.ts): a passive entry the model sees as a user message
// starting with the label below. The console shows it as 人工回复 and searches it as an answer (./read/queries.ts).

/** The entry kind of an operator's message. */
export const OPERATOR_NOTE_KIND = "mixin.operator-note";
/** How the entry starts for the model (src/agent/prompt.ts says what it is). */
export const OPERATOR_NOTE_LABEL = "[人工回复]";
