// Posts alerts to a Discord webhook. The webhook URL comes from the
// DISCORD_WEBHOOK_URL environment variable and is never logged.

import { truncate } from './text.js';

const COLORS = { breaking: 0xe53935, possible: 0xffb300, info: 0x546e7a, warn: 0x8e24aa };

function withWait(webhook) {
  const u = new URL(webhook);
  u.searchParams.set('wait', 'true');
  return u.toString();
}

function messageUrl(webhook, messageId) {
  const u = new URL(webhook);
  u.pathname = `${u.pathname.replace(/\/$/, '')}/messages/${messageId}`;
  return u.toString();
}

async function request(url, method, payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
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

// alert: { item, sceneLabel, result, outlets? }
export function buildAlertPayload(alert) {
  const { item, sceneLabel, result } = alert;
  const outlets = alert.outlets ?? [];
  const heading = result.level === 'breaking' ? '🚨 BREAKING' : '⚠️ POSSIBLE BREAKING';
  const fields = [
    { name: 'Scene', value: sceneLabel, inline: true },
    { name: 'Score', value: String(result.score), inline: true },
    { name: 'Source', value: truncate(item.sourceName, 100), inline: true },
  ];
  if (outlets.length > 1) {
    fields.push({ name: `Reported by ${outlets.length} outlets`, value: truncate(outlets.join(', '), 1000) });
  }
  fields.push({ name: 'Why', value: truncate(result.reasons.slice(0, 8).join(', ') || '-', 200) });
  const published = item.published ? new Date(item.published) : new Date();
  return {
    content: `${result.level === 'breaking' ? mentionPrefix() : ''}${heading} — ${sceneLabel}`,
    embeds: [{
      title: truncate(item.title, 256),
      url: item.url || undefined,
      color: COLORS[result.level],
      description: item.summary ? truncate(item.summary, 300) : undefined,
      fields,
      timestamp: published.toISOString(),
    }],
    allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
  };
}

// Returns the Discord message id so the alert can be updated later.
export async function sendAlert(webhook, alert) {
  const msg = await request(withWait(webhook), 'POST', buildAlertPayload(alert));
  return msg?.id ?? null;
}

// Rewrites an earlier alert in place (new outlets, new level). Edits never ping.
export async function editAlert(webhook, messageId, alert) {
  const { content, embeds } = buildAlertPayload(alert);
  await request(messageUrl(webhook, messageId), 'PATCH', { content, embeds, allowed_mentions: { parse: [] } });
}

// A short follow-up that does ping, for a POSSIBLE alert that became BREAKING.
export async function sendEscalation(webhook, alert) {
  const n = alert.outlets?.length ?? 0;
  const title = truncate(alert.item.title, 200);
  const link = alert.item.url ? `[${title}](${alert.item.url})` : title;
  await request(webhook, 'POST', {
    content: `${mentionPrefix()}⬆️ NOW BREAKING — ${alert.sceneLabel}: ${link} (${n} outlets reporting)`,
    allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
  });
}

export async function sendPayload(webhook, payload) {
  await request(webhook, 'POST', payload);
}

export async function sendNotice(webhook, text, kind = 'info') {
  await request(webhook, 'POST', {
    embeds: [{ description: truncate(text, 4000), color: COLORS[kind] ?? COLORS.info }],
    allowed_mentions: { parse: [] },
  });
}
