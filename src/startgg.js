// Tournament results from start.gg (the bracket site most of the FGC and
// Melee run on). Needs a free personal access token in STARTGG_TOKEN.

const API = 'https://api.start.gg/gql/alpha';

async function gql(token, query, variables) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`start.gg HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`start.gg: ${body.errors[0].message}`);
    return body.data;
  }
  throw new Error('start.gg: rate limited');
}

const GAMES_QUERY = `query Games($name: String) {
  videogames(query: { filter: { name: $name }, perPage: 10 }) { nodes { id name displayName } }
}`;

const TOURNAMENTS_QUERY = `query Tournaments($page: Int!, $after: Timestamp, $before: Timestamp, $vg: [ID]) {
  tournaments(query: { page: $page, perPage: 40, sortBy: "startAt asc",
    filter: { afterDate: $after, beforeDate: $before, videogameIds: $vg } }) {
    pageInfo { totalPages }
    nodes {
      id name slug startAt endAt isOnline
      events(filter: { videogameId: $vg }) { id name slug numEntrants state startAt videogame { id } }
    }
  }
}`;

const STANDINGS_QUERY = `query Standings($id: ID!) {
  event(id: $id) { standings(query: { perPage: 8, page: 1 }) { nodes { placement entrant { name } } } }
}`;

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Picks the start.gg games whose name matches the configured name as whole
// words (so "Mortal Kombat 1" doesn't also grab "Mortal Kombat 11").
export function matchGames(name, nodes) {
  const q = norm(name);
  const re = new RegExp(`(^| )${q.replace(/ /g, ' ')}( |$)`);
  return nodes.filter((n) => re.test(norm(n.name)) || re.test(norm(n.displayName)));
}

export async function resolveGames(token, games, cache = {}) {
  const resolved = {};
  for (const g of games) {
    if (cache[g.name]?.length) {
      resolved[g.name] = cache[g.name];
      continue;
    }
    const data = await gql(token, GAMES_QUERY, { name: g.name });
    const hits = matchGames(g.name, data.videogames?.nodes ?? []);
    resolved[g.name] = hits.map((h) => ({ id: String(h.id), name: h.name }));
  }
  return resolved;
}

// Returns { completed, live, upcoming } for notable events of the tracked games.
export async function fetchResults(token, config, cache, now = Date.now()) {
  const games = await resolveGames(token, config.games, cache.games);
  cache.games = games;
  const byId = new Map();
  for (const g of config.games) for (const v of games[g.name] ?? []) byId.set(v.id, g);
  const vg = [...byId.keys()];
  if (!vg.length) return { completed: [], live: [], upcoming: [], games };

  // Two windows (recent past, next week) so busy weeks of small weeklies in
  // one don't push the other off the page limit.
  const s = (ms) => Math.floor(ms / 1000);
  const windows = [
    [s(now - config.lookBackDays * 86400000), s(now)],
    [s(now), s(now + config.lookAheadDays * 86400000)],
  ];
  const seen = new Set();
  const tournaments = [];
  for (const [after, before] of windows) {
    for (let page = 1; page <= 8; page += 1) {
      const data = await gql(token, TOURNAMENTS_QUERY, { page, after, before, vg });
      const t = data.tournaments;
      for (const n of t?.nodes ?? []) if (!seen.has(n.id)) { seen.add(n.id); tournaments.push(n); }
      if (!t || page >= (t.pageInfo?.totalPages ?? 1)) break;
    }
  }

  const completed = [];
  const live = [];
  const upcoming = [];
  cache.standings ??= {};
  for (const t of tournaments) {
    for (const e of t.events ?? []) {
      const game = byId.get(String(e.videogame?.id));
      if (!game || (e.numEntrants ?? 0) < game.minEntrants) continue;
      const row = {
        eventId: String(e.id),
        scene: game.scene,
        game: game.name,
        tournament: t.name,
        event: e.name,
        entrants: e.numEntrants,
        online: Boolean(t.isOnline),
        major: e.numEntrants >= game.majorEntrants,
        startAt: new Date((e.startAt ?? t.startAt) * 1000).toISOString(),
        endAt: t.endAt ? new Date(t.endAt * 1000).toISOString() : null,
        url: `https://www.start.gg/${e.slug}`,
      };
      if (e.state === 'COMPLETED') {
        if (!cache.standings[row.eventId]) {
          const data = await gql(token, STANDINGS_QUERY, { id: row.eventId });
          const top8 = (data.event?.standings?.nodes ?? [])
            .map((n) => ({ placement: n.placement, name: n.entrant?.name }))
            .filter((n) => n.name);
          if (top8.length) cache.standings[row.eventId] = top8;
          row.top8 = top8;
        } else {
          row.top8 = cache.standings[row.eventId];
        }
        completed.push(row);
      } else if ((e.startAt ?? t.startAt) * 1000 > now) {
        // start.gg marks events ACTIVE once registration/seeding opens, so an
        // event that hasn't started yet is upcoming whatever its state says.
        upcoming.push(row);
      } else if (e.state === 'ACTIVE') {
        live.push(row);
      }
    }
  }
  const byEnd = (a, b) => (b.endAt || '').localeCompare(a.endAt || '');
  completed.sort(byEnd);
  upcoming.sort((a, b) => a.startAt.localeCompare(b.startAt));
  // Keep the standings cache from growing forever.
  const keep = new Set(completed.map((c) => c.eventId));
  for (const id of Object.keys(cache.standings)) if (!keep.has(id)) delete cache.standings[id];
  return { completed, live, upcoming, games };
}

export function resultLine(r) {
  const top = (r.top8 ?? []).slice(0, 3).map((p) => `${p.placement}. ${p.name}`).join(' · ');
  return `**${r.tournament}** (${r.event}, ${r.entrants} entrants): ${top || 'standings not posted yet'}`;
}

export function resultsEmbed(completed, sceneLabels, now = Date.now(), hours = 24) {
  const recent = completed.filter((r) => r.endAt && now - Date.parse(r.endAt) < hours * 3600000);
  if (!recent.length) return null;
  const lines = recent.slice(0, 12).map((r) => `[${sceneLabels[r.scene] ?? r.scene}] ${resultLine(r)} · [bracket](${r.url})`);
  return { title: `🏆 Results · ${recent.length} event${recent.length === 1 ? '' : 's'}`, description: lines.join('\n').slice(0, 4000), color: 0xf1c40f };
}
