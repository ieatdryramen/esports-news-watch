// "Developing story" logic: when several different outlets report the same
// story within a short window, it counts for more than any one headline, and
// later reports update the original alert instead of creating new ones.

import { jaccard } from './text.js';

// All Reddit posts count as one outlet, so five posts in one subreddit
// can't fake a story being widely reported.
export function outletOf(item) {
  if (item.kind === 'reddit') return 'Reddit';
  return item.publisher || item.sourceName;
}

// Distinct outlets that reported something similar inside the window.
export function corroboratingOutlets(tokens, recentItems, corroboration, now) {
  const windowMs = corroboration.windowMinutes * 60 * 1000;
  const outlets = new Set();
  for (const r of recentItems) {
    if (now - r.ts > windowMs) continue;
    if (jaccard(tokens, new Set(r.tokens)) >= corroboration.similarity) outlets.add(r.outlet);
  }
  return outlets;
}

// Applies the corroboration bonus. A story reported by enough outlets can
// alert even without a breaking keyword.
export function applyCorroboration(result, outletCount, scoring) {
  const c = scoring.corroboration;
  if (outletCount < c.minOutlets) return result;
  const score = Math.round((result.score + c.bonus) * 10) / 10;
  let level = null;
  if (score >= scoring.thresholds.breaking) level = 'breaking';
  else if (score >= scoring.thresholds.possible) level = 'possible';
  return { score, level, reasons: [...result.reasons, `${outletCount} outlets`] };
}

// Finds an earlier alert this story belongs to.
export function findAlertFor(tokens, alerts, scoring, now) {
  const windowMs = scoring.dedupeWindowHours * 3600 * 1000;
  return alerts.find((a) => now - a.ts < windowMs && jaccard(tokens, new Set(a.tokens)) >= scoring.dedupeSimilarity) ?? null;
}
