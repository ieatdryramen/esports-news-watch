// Writes machine-readable copies of what the bot found, so other tools can
// read them (the workflow publishes the .feed folder to the "feed" branch).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeAlertsFeed(dir, recentAlerts, now = Date.now()) {
  const alerts = recentAlerts
    .filter((a) => now - a.ts < 48 * 3600 * 1000)
    .sort((a, b) => b.ts - a.ts)
    .map((a) => ({
      alertedAt: new Date(a.ts).toISOString(),
      level: a.level,
      scene: a.sceneLabel,
      title: a.title,
      url: a.url,
      source: a.sourceName,
      outlets: a.outlets,
      score: a.score,
      why: a.reasons,
      summary: a.summary || '',
      published: a.published,
    }));
  await mkdir(dir, { recursive: true });
  // No timestamp at the top level, so the file only changes when alerts do
  // (and the feed branch only gets a commit when there's something new).
  await writeFile(join(dir, 'alerts.json'), `${JSON.stringify({ alerts }, null, 2)}\n`);
}

export async function writeRundownFeed(dir, rundown, now = Date.now()) {
  const data = {
    generatedAt: new Date(now).toISOString(),
    windowHours: 24,
    scenes: rundown.sections.map((s) => ({ scene: s.label, storyCount: s.count, stories: s.stories })),
    quiet: rundown.quiet,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rundown.json'), `${JSON.stringify(data, null, 2)}\n`);
}

export async function writeResultsFeed(dir, results, now = Date.now()) {
  const data = {
    generatedAt: new Date(now).toISOString(),
    source: 'start.gg',
    completed: results.completed,
    live: results.live,
    upcoming: results.upcoming,
    games: results.games,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'results.json'), `${JSON.stringify(data, null, 2)}\n`);
}
