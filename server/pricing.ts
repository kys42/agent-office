import type { SessionCost, UsageEntry } from '../src/shared/types.js';
export const RATE_VERSION = '2026-10-05.standard-base.v1';
// USD / million tokens: input, output, cache read, 5m write, 1h write.
// Official sources and the exclusions of this base-rate equivalent are documented.
const rates: Record<string, number[]> = {
  'gpt-6.1-sol': [2, 10, 0.1, 2.5, 2.5],
  'gpt-6-astra': [10, 50, 1, 12.5, 12.5],
  'gpt-6-luna': [0.1, 0.5, 0.01, 0.125, 0.125],
  'gpt-5.3-codex': [1.75, 14, 0.175, 0, 0],
  'gpt-5.6-sol': [4, 20, 0.4, 5, 5],
  'claude-opus-5-5': [4, 20, 0.2, 5, 8],
  'claude-sonnet-5-5': [2, 10, 0.2, 2.5, 4],
  'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-mythos-5-1': [10, 50, 0.25, 12.5, 20],
  'claude-fable-5': [10, 50, 1, 12.5, 20],
  'claude-mythos-5': [10, 50, 1, 12.5, 20],
  'claude-opus-5': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-8': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-7': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-6': [5, 25, 0.5, 6.25, 10],
  'claude-opus-4-5': [5, 25, 0.5, 6.25, 10],
  'claude-sonnet-5': [2, 10, 0.2, 2.5, 4],
  'claude-sonnet-4-6': [3, 15, 0.3, 3.75, 6],
  'claude-sonnet-4-5': [3, 15, 0.3, 3.75, 6],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
};
export function entryCost(entry: UsageEntry): number | null {
  const key = (entry.model ?? '').replace(/^.*\//, '').replace(/-\d{8}$/, '');
  const rate = rates[key];
  if (!rate) return null;
  return (
    [entry.input, entry.output, entry.cached, entry.cacheWrite, entry.cacheWriteHour].reduce(
      (sum, n, i) => sum + n * rate[i],
      0,
    ) / 1e6
  );
}
export function summarizeCost(entries: UsageEntry[]): SessionCost {
  let usd = 0,
    priced = 0,
    unpriced = 0,
    tokens = 0;
  for (const e of entries) {
    const amount = entryCost(e);
    if (amount === null) unpriced++;
    else {
      usd += amount;
      priced++;
    }
    tokens += e.input + e.output + e.cached + e.cacheWrite + e.cacheWriteHour;
  }
  return {
    usd: priced ? usd : null,
    priced,
    unpriced,
    tokens,
    since: entries.length ? Math.min(...entries.map((e) => e.at)) : null,
    rateVersion: RATE_VERSION,
  };
}
