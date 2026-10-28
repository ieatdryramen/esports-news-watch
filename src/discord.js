// Posts alerts to a Discord webhook. The webhook URL comes from the
// DISCORD_WEBHOOK_URL environment variable and is never logged.

import { truncate } from './text.js';

const COLORS = { breaking: 0xe53935, possible: 0xffb300, info: 0x546e7a, warn: 0x8e24aa };

async function post(webhook, payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 2) * 1000)));
      continue;
    }
    throw new Error(`Discord webhook returned HTTP ${res.status}`);
  }
  throw new Error('Discord webhook kept rate-limiting');
}

function mentionPrefix() {
  const m = process.env.ALERT_MENTION?.trim();
  return m ? `${m} ` : '';
}

export function buildAlertPayload(alert) {
  const { item, sceneLabel, result } = alert;
  const heading = result.level === 'breaking' ? '🚨 BREAKING' : '⚠️ POSSIBLE BREAKING';
  const embed = {
    title: truncate(item.title, 256),
    url: item.url || undefined,
    color: COLORS[result.level],
    description: item.summary ? truncate(item.summary, 300) : undefined,
    fields: [
      { name: 'Scene', value: sceneLabel, inline: true },
      { name: 'Score', value: String(result.score), inline: true },
      { name: 'Source', value: truncate(item.sourceName, 100), inline: true },
      { name: 'Why', value: truncate(result.reasons.slice(0, 8).join(', ') || '-', 200) },
    ],
    timestamp: (item.published ?? new Date()).toISOString(),
  };
  return {
    content: `${result.level === 'breaking' ? mentionPrefix() : ''}${heading} — ${sceneLabel}`,
    embeds: [embed],
    allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
  };
}

export async function sendAlert(webhook, alert) {
  await post(webhook, buildAlertPayload(alert));
}

export async function sendNotice(webhook, text, kind = 'info') {
  await post(webhook, {
    embeds: [{ description: truncate(text, 4000), color: COLORS[kind] ?? COLORS.info }],
    allowed_mentions: { parse: [] },
  });
}
