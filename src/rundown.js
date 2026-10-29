// Daily rundown: every story from the last 24 hours, grouped by scene and
// ranked, posted as one Discord message. A research sheet for a daily show.

import { detectScene, scoreItem } from './score.js';
import { hasTerm, jaccard, tokens, truncate } from './text.js';

const PER_SCENE = 6;
const EMBED_LIMIT = 4000; // Discord allows 4096 per embed description
const MESSAGE_LIMIT = 5800; // Discord allows 6000 characters per message

export function buildRundown(results, scenes, scoring, now = Date.now(), hours = 24) {
  const byScene = new Map();
  for (const r of results) {
    for (const item of r.items) {
      if (!item.published || now - item.published.getTime() > hours * 3600 * 1000) continue;
      const sceneKey = detectScene(item, scenes);
      if (!sceneKey) continue;
      const result = scoreItem(item, scenes[sceneKey], scoring);
      if (result.score < 0) continue; // betting pages, memes, help posts
      if (item.kind === 'reddit' && !redditIsNews(item, result, scoring)) continue;
      const list = byScene.get(sceneKey) ?? [];
      list.push({ item, result, tokens: tokens(item.title) });
      byScene.set(sceneKey, list);
    }
  }

  const sections = [];
  for (const [sceneKey, list] of byScene) {
    list.sort((a, b) => b.result.score - a.result.score || b.item.published - a.item.published);
    const kept = [];
    for (const s of list) {
      if (kept.some((k) => jaccard(k.tokens, s.tokens) >= scoring.dedupeSimilarity)) continue;
      kept.push(s);
    }
    const top = kept.slice(0, PER_SCENE);
    const lines = top.map((s) => {
      const flag = s.result.level === 'breaking' ? '🚨 ' : s.result.level === 'possible' ? '⚠️ ' : '';
      const title = truncate(s.item.title, 110).replace(/[[\]]/g, '');
      const link = s.item.url ? `[${title}](${s.item.url})` : title;
      return `${flag}${link} · ${truncate(s.item.sourceName, 40)}`;
    });
    sections.push({
      label: scenes[sceneKey].label,
      count: kept.length,
      best: top[0]?.result.score ?? 0,
      text: truncate(lines.join('\n'), EMBED_LIMIT),
      // Structured copy for the published feed (up to 12 per scene).
      stories: kept.slice(0, 12).map((s) => ({
        title: s.item.title,
        url: s.item.url,
        source: s.item.sourceName,
        published: s.item.published.toISOString(),
        score: s.result.score,
        level: s.result.level,
        why: s.result.reasons.slice(0, 6),
      })),
    });
  }
  sections.sort((a, b) => b.best - a.best || b.count - a.count);

  const quiet = Object.entries(scenes)
    .filter(([key]) => !key.startsWith('_') && !byScene.has(key))
    .map(([, s]) => s.label);
  return { sections, quiet };
}

// Busy player subs are mostly help posts and clips. A Reddit post makes the
// rundown only if its title hits a breaking term, a scene name, or a news word.
function redditIsNews(item, result, scoring) {
  if (result.reasons.some((r) => !r.endsWith('*') && !r.startsWith('-'))) return true;
  const terms = scoring.rundownRedditTerms?.terms ?? [];
  return terms.some((t) => hasTerm(item.title || '', t));
}

// Splits the rundown into Discord payloads that fit the size limits.
export function rundownPayloads(rundown, dateLabel) {
  const embeds = rundown.sections.map((s) => ({
    title: `${s.label} · ${s.count} ${s.count === 1 ? 'story' : 'stories'}`,
    description: s.text,
    color: 0x546e7a,
  }));
  if (!embeds.length) embeds.push({ description: 'No stories in the last 24 hours.', color: 0x546e7a });

  const payloads = [];
  let current = [];
  let size = 0;
  for (const e of embeds) {
    const len = (e.title?.length ?? 0) + e.description.length;
    if (current.length && (current.length === 10 || size + len > MESSAGE_LIMIT)) {
      payloads.push(current);
      current = [];
      size = 0;
    }
    current.push(e);
    size += len;
  }
  payloads.push(current);

  const quietLine = rundown.quiet.length ? `\nQuiet: ${rundown.quiet.join(', ')}` : '';
  return payloads.map((embedsPart, i) => ({
    content: i === 0 ? `📋 **Daily rundown — ${dateLabel}** (last 24 hours, biggest first)${quietLine}` : undefined,
    embeds: embedsPart,
    allowed_mentions: { parse: [] },
  }));
}
