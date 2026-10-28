#!/usr/bin/env node
// Breaking-news watcher. One run = fetch every source once, alert on new
// high-scoring stories, remember what was seen. Schedule it every few minutes.
//
//   node src/index.js           normal run (needs DISCORD_WEBHOOK_URL to post)
//   node src/index.js --check   test every source and show top-scoring stories; sends nothing

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildJobs, runJobs } from './fetchers.js';
import { detectScene, scoreItem } from './score.js';
import { jaccard, tokens, truncate } from './text.js';
import { loadState, saveState } from './state.js';
import { sendAlert, sendNotice } from './discord.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = process.env.STATE_PATH || join(ROOT, '.state', 'state.json');
const DOWN_AFTER_FAILURES = 12; // about an hour at a 5-minute schedule

async function loadJson(name) {
  return JSON.parse(await readFile(join(ROOT, 'config', name), 'utf8'));
}

function ageLabel(date, now) {
  if (!date) return '?';
  const mins = Math.round((now - date.getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

function summary(results) {
  const ok = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const active = results.length - skipped;
  return `${ok}/${active} sources working${skipped ? ` (${skipped} skipped: no Reddit keys yet)` : ''}`;
}

async function check(results, scenes, scoring) {
  const now = Date.now();
  console.log('SOURCE HEALTH');
  for (const r of results) {
    const newest = r.items.map((i) => i.published).filter(Boolean).sort((a, b) => b - a)[0];
    const status = r.ok
      ? `OK   ${String(r.items.length).padStart(3)} items, newest ${ageLabel(newest, now)}`
      : r.skipped ? `SKIP ${r.error}` : `FAIL ${r.error}`;
    console.log(`  ${r.name.padEnd(28)} ${status}`);
  }
  console.log(`\n${summary(results)}\n`);

  const scored = [];
  for (const r of results) {
    for (const item of r.items) {
      if (item.published && now - item.published.getTime() > 48 * 3600 * 1000) continue;
      const sceneKey = detectScene(item, scenes);
      if (!sceneKey) continue;
      scored.push({ item, sceneKey, result: scoreItem(item, scenes[sceneKey], scoring) });
    }
  }
  scored.sort((a, b) => b.result.score - a.result.score);
  console.log('TOP STORIES, LAST 48H (what would alert is marked)');
  for (const s of scored.slice(0, 25)) {
    const mark = s.result.level === 'breaking' ? 'BREAKING' : s.result.level === 'possible' ? 'POSSIBLE' : '        ';
    console.log(`  ${mark} ${String(s.result.score).padStart(5)}  [${scenes[s.sceneKey].label}] ${truncate(s.item.title, 90)}`);
    console.log(`           ${ageLabel(s.item.published, now)} ago · ${s.item.sourceName} · ${s.result.reasons.slice(0, 6).join(', ')}`);
  }
  const byScene = {};
  for (const s of scored) byScene[scenes[s.sceneKey].label] = (byScene[scenes[s.sceneKey].label] || 0) + 1;
  console.log('\nSTORIES PER SCENE, LAST 48H');
  for (const [label, n] of Object.entries(byScene).sort((a, b) => b[1] - a[1])) console.log(`  ${label.padEnd(16)} ${n}`);
}

async function run() {
  const [scenes, scoring, sourceConfig] = await Promise.all([
    loadJson('scenes.json'), loadJson('scoring.json'), loadJson('sources.json'),
  ]);
  const results = await runJobs(buildJobs(sourceConfig));

  if (process.argv.includes('--check')) {
    await check(results, scenes, scoring);
    return;
  }

  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  const dryRun = process.env.DRY_RUN === '1' || !webhook;
  const now = Date.now();
  const state = await loadState(STATE_PATH);
  const firstRun = Object.keys(state.seededSources).length === 0;
  const notices = [];
  const candidates = [];
  let freshCount = 0;

  for (const r of results) {
    if (r.skipped) continue;
    // Source health tracking.
    if (!r.ok) {
      state.failures[r.name] = (state.failures[r.name] || 0) + 1;
      console.log(`source failed: ${r.name}: ${r.error}`);
      if (state.failures[r.name] === DOWN_AFTER_FAILURES && !state.downNotified[r.name]) {
        state.downNotified[r.name] = now;
        notices.push({ kind: 'warn', text: `Source down for about an hour: **${r.name}** (${r.error})` });
      }
      continue;
    }
    if (state.downNotified[r.name]) {
      notices.push({ kind: 'info', text: `Source back up: **${r.name}**` });
      delete state.downNotified[r.name];
    }
    state.failures[r.name] = 0;

    // A source's first successful fetch only records what's there, so old stories don't flood.
    if (!state.seededSources[r.name]) {
      for (const item of r.items) state.seen[item.id] = now;
      state.seededSources[r.name] = now;
      continue;
    }

    for (const item of r.items) {
      if (state.seen[item.id]) continue;
      freshCount += 1;
      state.seen[item.id] = now; // undone below if an alert fails to send
      const sceneKey = detectScene(item, scenes);
      if (!sceneKey) continue;
      if (item.published && now - item.published.getTime() > scoring.maxAgeHours * 3600 * 1000) continue;
      const result = scoreItem(item, scenes[sceneKey], scoring);
      if (!result.level) continue;
      candidates.push({ item, sceneKey, sceneLabel: scenes[sceneKey].label, result, tokens: tokens(item.title) });
    }
  }

  // Drop repeats: the same story posted by several sources, or already alerted recently.
  candidates.sort((a, b) => b.result.score - a.result.score);
  const windowMs = scoring.dedupeWindowHours * 3600 * 1000;
  const recent = state.recentAlerts.filter((a) => now - a.ts < windowMs).map((a) => new Set(a.tokens));
  const alerts = [];
  for (const c of candidates) {
    if (recent.some((t) => jaccard(t, c.tokens) >= scoring.dedupeSimilarity)) continue;
    if (alerts.some((a) => jaccard(a.tokens, c.tokens) >= scoring.dedupeSimilarity)) continue;
    alerts.push(c);
  }
  const toSend = alerts.slice(0, scoring.maxAlertsPerRun);
  if (alerts.length > toSend.length) {
    notices.push({ kind: 'info', text: `${alerts.length - toSend.length} more lower-scoring stories skipped this run.` });
  }

  // Say hello the first time a webhook is connected, so setup is confirmed in Discord.
  if (firstRun || (!dryRun && !state.announced)) {
    if (!dryRun) state.announced = now;
    notices.unshift({ kind: 'info', text: `News watcher online. ${summary(results)}. Alerts start with the next new story.` });
  }

  for (const a of toSend) {
    console.log(`${a.result.level.toUpperCase()} ${a.result.score} [${a.sceneLabel}] ${a.item.title} — ${a.item.sourceName} — ${a.item.url}`);
  }
  for (const n of notices) console.log(`NOTICE: ${n.text}`);

  let sendFailed = false;
  if (!dryRun) {
    for (const n of notices) {
      try { await sendNotice(webhook, n.text, n.kind); } catch (err) { console.error(`notice failed: ${err.message}`); }
    }
    for (const a of toSend) {
      try {
        await sendAlert(webhook, a);
        state.recentAlerts.push({ ts: now, tokens: [...a.tokens], title: a.item.title });
      } catch (err) {
        sendFailed = true;
        delete state.seen[a.item.id]; // retry next run
        console.error(`alert failed: ${err.message}`);
      }
    }
  } else {
    console.log('(dry run: no webhook set, nothing posted)');
    for (const a of toSend) state.recentAlerts.push({ ts: now, tokens: [...a.tokens], title: a.item.title });
  }

  await saveState(STATE_PATH, state, now);
  console.log(`done: ${summary(results)}, ${freshCount} new items, ${toSend.length} alerts`);
  if (sendFailed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
