import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hasTerm, jaccard, tokens, splitPublisher, stripHtml } from '../src/text.js';
import { parseFeed } from '../src/fetchers.js';
import { detectScene, scoreItem } from '../src/score.js';
import { buildAlertPayload } from '../src/discord.js';

const scenes = JSON.parse(await readFile(new URL('../config/scenes.json', import.meta.url)));
const scoring = JSON.parse(await readFile(new URL('../config/scoring.json', import.meta.url)));

test('whole-word matching', () => {
  assert.ok(hasTerm('Mang0 wins Genesis', 'mang0'));
  assert.ok(!hasTerm('banner ad', 'ban'));
  assert.ok(hasTerm('Player BANNED for cheating', 'banned'));
  assert.ok(hasTerm('Team parts  ways with star', 'parts ways'));
  assert.ok(!hasTerm('bwah', 'bw'));
});

test('html and publisher cleanup', () => {
  assert.equal(stripHtml('<p>Hera &amp; TheViper</p>'), 'Hera & TheViper');
  assert.deepEqual(splitPublisher('Dog wins CTWC again - Tetris Interest'), { title: 'Dog wins CTWC again', publisher: 'Tetris Interest' });
});

test('title similarity catches the same story', () => {
  const a = tokens('SoulKey beats Rush 4-3 to win ASL Season 22');
  const b = tokens('ASL Season 22: SoulKey beats Rush 4-3 to win the title');
  assert.ok(jaccard(a, b) >= scoring.dedupeSimilarity);
  assert.ok(jaccard(a, tokens('Hera wins Red Bull Wololo')) < 0.2);
});

test('parses RSS and Atom', () => {
  const rss = '<rss><channel><item><title>Big news</title><link>https://x.test/1</link><guid>1</guid><pubDate>Wed, 28 Oct 2026 20:00:00 GMT</pubDate><description>&lt;b&gt;hi&lt;/b&gt;</description></item></channel></rss>';
  const [r] = parseFeed(rss);
  assert.equal(r.title, 'Big news');
  assert.equal(r.summary, 'hi');
  assert.equal(r.published.toISOString(), '2026-10-28T20:00:00.000Z');
  const atom = '<feed><entry><id>t3_abc</id><title>Leffen retires</title><link href="https://reddit.test/abc"/><updated>2026-10-28T20:00:00Z</updated><content type="html">&lt;p&gt;wow&lt;/p&gt;</content></entry></feed>';
  const [a] = parseFeed(atom);
  assert.equal(a.url, 'https://reddit.test/abc');
  assert.equal(a.summary, 'wow');
});

test('scene detection for mixed feeds', () => {
  assert.equal(detectScene({ title: 'Warcraft III Reforged gets new campaign', summary: '', scene: 'auto' }, scenes), 'wc3');
  assert.equal(detectScene({ title: 'Valorant patch notes', summary: '', scene: 'auto' }, scenes), null);
  assert.equal(detectScene({ title: 'anything', summary: '', scene: 'melee' }, scenes), 'melee');
});

test('scoring: real breaking news alerts, chatter does not', () => {
  const big = scoreItem({ title: 'Mang0 retires from competitive Melee after Genesis upset', summary: '', kind: 'news' }, scenes.melee, scoring);
  assert.equal(big.level, 'breaking');
  const chatter = scoreItem({ title: 'Rate my Fox combo clip', summary: '', kind: 'reddit' }, scenes.melee, scoring);
  assert.equal(chatter.level, null);
  const namesOnly = scoreItem({ title: 'Hungrybox and Zain at Genesis', summary: '', kind: 'news' }, scenes.melee, scoring);
  assert.equal(namesOnly.level, null);
});

test('rundown groups by scene, drops repeats and noise, fits Discord limits', async () => {
  const { buildRundown, rundownPayloads } = await import('../src/rundown.js');
  const now = Date.now();
  const mk = (title, scene, mins) => ({ title, url: 'https://x.test/' + encodeURIComponent(title), summary: '', kind: 'news', scene, sourceName: 'Test', published: new Date(now - mins * 60000) });
  const results = [{ ok: true, items: [
    mk('NAVI beat Spirit to make playoffs', 'cs2', 30),
    mk('NAVI beat Spirit to make the playoffs in Bucharest', 'cs2', 40),
    mk('Prediction market odds for tonight', 'cs2', 50),
    mk('Mang0 wins Genesis', 'melee', 60),
    mk('Old story', 'melee', 60 * 30),
  ] }];
  const r = buildRundown(results, scenes, scoring, now);
  const cs = r.sections.find((s) => s.label === 'CS2');
  assert.equal(cs.count, 1);
  assert.ok(r.sections.find((s) => s.label === 'Melee'));
  assert.ok(r.quiet.includes('Trackmania'));
  const payloads = rundownPayloads(r, 'Wed, Oct 28');
  assert.match(payloads[0].content, /Daily rundown/);
  for (const p of payloads) assert.ok(p.embeds.length <= 10);
});

test('discord payload shape', () => {
  const p = buildAlertPayload({
    item: { title: 'X', url: 'https://x.test', summary: '', sourceName: 'HLTV news', published: new Date() },
    sceneLabel: 'CS2',
    result: { level: 'breaking', score: 9, reasons: ['banned'] },
  });
  assert.match(p.content, /BREAKING — CS2/);
  assert.equal(p.embeds.length, 1);
});
