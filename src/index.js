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
import { editAlert, sendAlert, sendEscalation, sendNotice, sendPayload } from './discord.js';
import { applyCorroboration, corroboratingOutlets, findAlertFor, outletOf } from './developing.js';
import { buildRundown, rundownPayloads } from './rundown.js';
import { writeAlertsFeed, writeRundownFeed } from './feed.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = process.env.STATE_PATH || join(ROOT, '.state', 'state.json');
const FEED_DIR = process.env.FEED_DIR || join(ROOT, '.feed');
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
  return `${ok}/${active} sources working${skipped ? ' (Reddit skipped: blocked without app keys)' : ''}`;
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

  if (process.argv.includes('--rundown')) {
    const rundown = buildRundown(results, scenes, scoring);
    const tz = process.env.RUNDOWN_TIMEZONE || 'America/New_York';
    const dateLabel = new Date().toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
    const payloads = rundownPayloads(rundown, dateLabel);
    await writeRundownFeed(FEED_DIR, rundown);
    for (const p of payloads) {
      if (p.content) console.log(p.content);
      for (const e of p.embeds) console.log(`\n## ${e.title ?? ''}\n${e.description}`);
    }
    // The feed file refreshes every run; Discord only gets the rundown at the
    // posting hours (local time), or whenever it's run by hand.
    const postHours = (process.env.RUNDOWN_POST_HOURS || '9,17').split(',').map((h) => Number(h.trim()));
    const localHour = Number(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }));
    const shouldPost = process.env.FORCE_POST === '1' || postHours.includes(localHour);
    const target = process.env.DISCORD_RUNDOWN_WEBHOOK_URL?.trim() || webhook;
    if (!shouldPost) {
      console.log(`\nfeed refreshed; not a posting hour (${localHour}:00 ${tz}, posts at ${postHours.join(', ')})`);
    } else if (target && process.env.DRY_RUN !== '1') {
      for (const p of payloads) await sendPayload(target, p);
      console.log(`\nposted rundown in ${payloads.length} message(s)`);
    } else {
      console.log('\n(dry run: no webhook set, nothing posted)');
    }
    return;
  }
  const dryRun = process.env.DRY_RUN === '1' || !webhook;
  const now = Date.now();
  const state = await loadState(STATE_PATH);
  const firstRun = Object.keys(state.seededSources).length === 0;
  const notices = [];
  const fresh = [];
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
      fresh.push({
        item,
        sceneKey,
        sceneLabel: scenes[sceneKey].label,
        result: scoreItem(item, scenes[sceneKey], scoring),
        tokens: tokens(item.title),
        outlet: outletOf(item),
      });
    }
  }

  // Every fresh story feeds the "who else is reporting this" memory.
  for (const f of fresh) state.recentItems.push({ ts: now, tokens: [...f.tokens], outlet: f.outlet });

  fresh.sort((a, b) => b.result.score - a.result.score);
  const alerts = [];
  const updated = new Set();
  for (const f of fresh) {
    // Same story as an earlier alert: add this outlet to it instead of alerting again.
    const earlier = findAlertFor(f.tokens, state.recentAlerts, scoring, now);
    if (earlier) {
      if (!earlier.outlets.includes(f.outlet)) {
        earlier.outlets.push(f.outlet);
        updated.add(earlier);
      }
      continue;
    }
    const sameRun = alerts.find((a) => jaccard(a.tokens, f.tokens) >= scoring.dedupeSimilarity);
    if (sameRun) {
      if (!sameRun.outlets.includes(f.outlet)) sameRun.outlets.push(f.outlet);
      continue;
    }
    const outlets = corroboratingOutlets(f.tokens, state.recentItems, scoring.corroboration, now);
    outlets.add(f.outlet);
    f.result = applyCorroboration(f.result, outlets.size, scoring);
    if (!f.result.level) continue;
    f.outlets = [...outlets];
    alerts.push(f);
  }

  const toSend = alerts.slice(0, scoring.maxAlertsPerRun);
  if (alerts.length > toSend.length) {
    notices.push({ kind: 'info', text: `${alerts.length - toSend.length} more lower-scoring stories skipped this run.` });
  }

  // A POSSIBLE alert that enough outlets have now picked up becomes BREAKING.
  const escalations = [];
  for (const a of updated) {
    if (a.level === 'possible' && a.outlets.length >= scoring.corroboration.minOutlets) {
      a.level = 'breaking';
      a.reasons = [...(a.reasons || []), `${a.outlets.length} outlets`];
      escalations.push(a);
    }
  }

  // Say hello the first time a webhook is connected, so setup is confirmed in Discord.
  if (firstRun || (!dryRun && !state.announced)) {
    if (!dryRun) state.announced = now;
    notices.unshift({ kind: 'info', text: `News watcher online. ${summary(results)}. Alerts start with the next new story.` });
  }

  for (const a of toSend) {
    console.log(`${a.result.level.toUpperCase()} ${a.result.score} [${a.sceneLabel}] ${a.item.title} — ${a.outlets.join(', ')} — ${a.item.url}`);
  }
  for (const a of updated) console.log(`UPDATE [${a.sceneLabel}] ${a.title} — now ${a.outlets.length} outlets${escalations.includes(a) ? ', ESCALATED to BREAKING' : ''}`);
  for (const n of notices) console.log(`NOTICE: ${n.text}`);

  const toRecord = (a, messageId) => ({
    ts: now,
    tokens: [...a.tokens],
    title: a.item.title,
    url: a.item.url,
    summary: a.item.summary,
    sourceName: a.item.sourceName,
    published: a.item.published ? a.item.published.toISOString() : null,
    sceneLabel: a.sceneLabel,
    level: a.result.level,
    score: a.result.score,
    reasons: a.result.reasons,
    outlets: a.outlets,
    messageId,
  });
  const fromRecord = (r) => ({
    item: { title: r.title, url: r.url, summary: r.summary, sourceName: r.sourceName, published: r.published },
    sceneLabel: r.sceneLabel,
    result: { level: r.level, score: r.score, reasons: r.reasons || [] },
    outlets: r.outlets,
  });

  let sendFailed = false;
  if (!dryRun) {
    for (const n of notices) {
      try { await sendNotice(webhook, n.text, n.kind); } catch (err) { console.error(`notice failed: ${err.message}`); }
    }
    for (const a of toSend) {
      try {
        const messageId = await sendAlert(webhook, a);
        state.recentAlerts.push(toRecord(a, messageId));
      } catch (err) {
        sendFailed = true;
        delete state.seen[a.item.id]; // retry next run
        console.error(`alert failed: ${err.message}`);
      }
    }
    for (const a of updated) {
      try {
        if (a.messageId) await editAlert(webhook, a.messageId, fromRecord(a));
        if (escalations.includes(a)) await sendEscalation(webhook, fromRecord(a));
      } catch (err) {
        console.error(`alert update failed: ${err.message}`);
      }
    }
  } else {
    console.log('(dry run: no webhook set, nothing posted)');
    for (const a of toSend) state.recentAlerts.push(toRecord(a, null));
  }

  await saveState(STATE_PATH, state, now);
  await writeAlertsFeed(FEED_DIR, state.recentAlerts, now);
  console.log(`done: ${summary(results)}, ${freshCount} new items, ${toSend.length} alerts, ${updated.size} updates`);
  if (sendFailed) process.exitCode = 1;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
