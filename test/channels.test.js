import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectScene, scoreItem } from '../src/score.js';
import { matchGames } from '../src/startgg.js';

const load = async (ch, f) => JSON.parse(await readFile(new URL(`../config/channels/${ch}/${f}`, import.meta.url)));

for (const ch of ['rivals', 'tokon']) {
  test(`${ch}: config files load and every source has a scene`, async () => {
    const [scenes, sources] = await Promise.all([load(ch, 'scenes.json'), load(ch, 'sources.json')]);
    await load(ch, 'scoring.json'); await load(ch, 'startgg.json');
    for (const s of sources.sources) assert.ok(s.scene === 'auto' || scenes[s.scene], `${s.name} -> ${s.scene}`);
  });
}

test('rivals: Google drift and other games are dropped, real stories score', async () => {
  const scenes = await load('rivals', 'scenes.json'); const scoring = await load('rivals', 'scoring.json');
  const g = (title) => ({ title, summary: '', kind: 'google', scene: 'rivals' });
  assert.equal(detectScene(g('NAVI win IEM Chengdu'), scenes), null);
  assert.equal(detectScene(g('Fortnite Treasure Hunters Mini Season Release Date Announced'), scenes), null);
  const item = g('Marvel Rivals Ignite Grand Finals: NAVI eliminated by Virtus.pro');
  assert.equal(detectScene(item, scenes), 'rivals');
  assert.ok(scoreItem(item, scenes.rivals, scoring).level);
  const patch = g('Marvel Rivals Season 5 patch notes: big Hela nerf');
  assert.ok(scoreItem(patch, scenes.rivals, scoring).score >= scoring.thresholds.possible);
});

test('tokon: macron spelling matches; start.gg name finds the game', async () => {
  const scenes = await load('tokon', 'scenes.json');
  assert.equal(detectScene({ title: 'Phoenix Cyclops joins MARVEL Tōkon: Fighting Souls on November 2', summary: '', kind: 'news', scene: 'auto' }, scenes), 'tokon');
  assert.equal(detectScene({ title: 'Evo Brazil 2027 unveils games lineup', summary: '', kind: 'google', scene: 'tokon' }, scenes), null);
  const sg = await load('tokon', 'startgg.json');
  assert.equal(matchGames(sg.games[0].name, [{ id: 1, name: 'MARVEL Tōkon: Fighting Souls' }, { id: 2, name: 'Soulcalibur VI' }]).length, 1);
});

test('BBN config is untouched by channel scenes', async () => {
  const bbn = JSON.parse(await readFile(new URL('../config/scenes.json', import.meta.url)));
  assert.ok(!('rivals' in bbn) && !('tokon' in bbn));
});
