import type { Usage } from "@earendil-works/pi-ai";

function cloneUsage(usage: Usage): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

/** Add two Pi usage snapshots field-by-field, preserving optional fields when either side has them. */
export function combineUsage(first: Usage, second: Usage): Usage {
  return {
    input: first.input + second.input,
    output: first.output + second.output,
    cacheRead: first.cacheRead + second.cacheRead,
    cacheWrite: first.cacheWrite + second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) } : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) } : {}),
    totalTokens: first.totalTokens + second.totalTokens,
    cost: {
      input: first.cost.input + second.cost.input,
      output: first.cost.output + second.cost.output,
      cacheRead: first.cost.cacheRead + second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
      total: first.cost.total + second.cost.total,
    },
  };
}

/** Sum any number of optional Pi usage snapshots; returns a fresh copy or undefined when none were present. */
export function sumUsage(usages: Iterable<Usage | undefined>): Usage | undefined {
  let total: Usage | undefined;
  for (const usage of usages) {
    if (usage === undefined) continue;
    total = total === undefined ? cloneUsage(usage) : combineUsage(total, usage);
  }
  return total;
}
