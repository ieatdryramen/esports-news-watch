// Decides which scene a story belongs to and how "breaking" it is.

import { hasTerm, matchTerms } from './text.js';

export function detectScene(item, scenes) {
  if (item.scene && item.scene !== 'auto') {
    const scene = scenes[item.scene];
    if (!scene) return null;
    // Google News searches drift off-topic, so require a scene term or name in the story.
    if (item.kind === 'google') {
      const text = `${item.title} ${item.summary}`;
      // strictGoogle (channel configs): team names like NAVI are shared with other games, so only terms count here.
      const words = scene.strictGoogle ? scene.terms : [...scene.terms, ...(scene.names || [])];
      if (!matchTerms(text, words).length) return null;
    }
    return item.scene;
  }
  const text = `${item.title} ${item.summary}`;
  let best = null;
  let bestHits = 0;
  for (const [key, scene] of Object.entries(scenes)) {
    if (key.startsWith('_')) continue;
    const hits = matchTerms(text, scene.terms).length;
    if (hits > bestHits) {
      best = key;
      bestHits = hits;
    }
  }
  return best;
}

export function scoreItem(item, scene, scoring) {
  const title = item.title || '';
  const body = item.summary || '';
  const reasons = [];
  let breaking = 0;

  for (const [term, weight] of Object.entries(scoring.breakingTerms)) {
    if (term.startsWith('_')) continue;
    if (hasTerm(title, term)) {
      breaking += weight;
      reasons.push(term);
    } else if (hasTerm(body, term)) {
      breaking += weight / 2;
      reasons.push(`${term}*`);
    }
  }
  breaking = Math.min(breaking, 10);

  let names = 0;
  for (const name of scene.names || []) {
    if (hasTerm(title, name)) {
      names += scoring.nameWeight;
      reasons.push(name);
    } else if (hasTerm(body, name)) {
      names += scoring.nameWeight / 2;
      reasons.push(`${name}*`);
    }
  }
  names = Math.min(names, scoring.maxNameBonus);

  let noise = 0;
  for (const [term, weight] of Object.entries(scoring.noiseTerms)) {
    if (term.startsWith('_')) continue;
    if (hasTerm(title, term)) {
      noise += weight;
      reasons.push(`-${term}`);
    }
  }

  const sourceWeight = scoring.sourceWeights[item.kind] ?? 0;
  const score = Math.round((breaking + names + sourceWeight - noise) * 10) / 10;

  let level = null;
  // A story needs at least one breaking term; names alone never alert.
  if (breaking > 0) {
    if (score >= scoring.thresholds.breaking) level = 'breaking';
    else if (score >= scoring.thresholds.possible) level = 'possible';
  }
  // Reddit alone never makes BREAKING: trivia and rumor threads score high.
  // A Reddit story still goes BREAKING once real outlets corroborate it.
  if (level === 'breaking' && item.kind === 'reddit') {
    level = 'possible';
    reasons.push('reddit only');
  }
  return { score, level, reasons };
}
