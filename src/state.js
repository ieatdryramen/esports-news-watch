// Remembers what has already been seen and alerted, between runs.
// On GitHub Actions this file is carried from run to run by the cache.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyState() {
  return { seen: {}, seededSources: {}, recentAlerts: [], recentItems: [], failures: {}, downNotified: {} };
}

export async function loadState(path) {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    const state = { ...emptyState(), ...data };
    // Alerts saved by older versions have no outlet list.
    state.recentAlerts = state.recentAlerts.map((a) => ({ outlets: [], reasons: [], ...a }));
    return state;
  } catch {
    return emptyState();
  }
}

export async function saveState(path, state, now = Date.now()) {
  // Forget seen items after 7 days and alerts after 2 days so the file stays small.
  for (const [id, ts] of Object.entries(state.seen)) {
    if (now - ts > 7 * DAY_MS) delete state.seen[id];
  }
  state.recentAlerts = state.recentAlerts.filter((a) => now - a.ts < 2 * DAY_MS);
  state.recentItems = state.recentItems.filter((r) => now - r.ts < 3 * 60 * 60 * 1000);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state));
}
