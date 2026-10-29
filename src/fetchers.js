// Fetches each source type and turns it into a common item shape:
// { id, title, url, summary, published, sourceName, kind, scene }

import { XMLParser } from 'fast-xml-parser';
import { stripHtml, splitPublisher } from './text.js';

const USER_AGENT = 'esports-news-watch/1.0 (open-source news alert bot)';
const TIMEOUT_MS = 15000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...extraHeaders },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in v) return String(v['#text']);
  return '';
}

function parseDate(v) {
  const s = textOf(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function atomLink(link) {
  const links = asArray(link);
  const alt = links.find((l) => typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  const pick = alt ?? links[0];
  if (!pick) return '';
  return typeof pick === 'string' ? pick : pick['@_href'] ?? '';
}

// Parses RSS 2.0 or Atom XML into raw entries.
export function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc?.rss?.channel) {
    return asArray(doc.rss.channel.item).map((it) => ({
      id: textOf(it.guid) || textOf(it.link),
      title: stripHtml(textOf(it.title)),
      url: textOf(it.link),
      summary: stripHtml(textOf(it.description) || textOf(it['content:encoded'])),
      published: parseDate(it.pubDate ?? it['dc:date']),
    }));
  }
  if (doc?.feed) {
    return asArray(doc.feed.entry).map((it) => ({
      id: textOf(it.id) || atomLink(it.link),
      title: stripHtml(textOf(it.title)),
      url: atomLink(it.link),
      summary: stripHtml(textOf(it.content) || textOf(it.summary)),
      published: parseDate(it.published ?? it.updated),
    }));
  }
  if (doc?.['rdf:RDF']) {
    return asArray(doc['rdf:RDF'].item).map((it) => ({
      id: textOf(it.link),
      title: stripHtml(textOf(it.title)),
      url: textOf(it.link),
      summary: stripHtml(textOf(it.description)),
      published: parseDate(it['dc:date']),
    }));
  }
  throw new Error('Not an RSS or Atom feed');
}

function finish(source, entries) {
  return entries
    .filter((e) => e.title && (e.id || e.url))
    .map((e) => ({
      ...e,
      id: `${source.name}::${e.id || e.url}`,
      summary: (e.summary || '').slice(0, 1500),
      sourceName: e.publisher ? `${source.name} (${e.publisher})` : source.name,
      kind: source.kind || 'news',
      scene: source.scene || 'auto',
    }));
}

async function fetchRss(source) {
  return finish(source, parseFeed(await fetchText(source.url)));
}

async function fetchGoogle(source) {
  const q = encodeURIComponent(`${source.query} when:1d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
  const entries = parseFeed(await fetchText(url)).map((e) => {
    const { title, publisher } = splitPublisher(e.title);
    // Google's description is just the headline again as a link; drop it.
    return { ...e, title, publisher, summary: '' };
  });
  return finish(source, entries);
}

// Reddit blocks anonymous requests from cloud servers, so this uses Reddit's
// free official API with an app-only token (no Reddit account login needed).
export class SkipError extends Error {}

let redditToken = null;

async function getRedditToken() {
  const id = process.env.REDDIT_CLIENT_ID?.trim();
  const secret = process.env.REDDIT_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  if (!redditToken) {
    redditToken = (async () => {
      const res = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Reddit token HTTP ${res.status}`);
      const data = await res.json();
      if (!data.access_token) throw new Error('Reddit token missing in response');
      return data.access_token;
    })();
  }
  return redditToken;
}

// Without keys, try Reddit's public RSS. Reddit often blocks cloud servers;
// a block is reported as "skipped", not as a broken source.
async function fetchRedditAnonymous(source) {
  for (const host of ['www.reddit.com', 'old.reddit.com']) {
    try {
      return finish(source, parseFeed(await fetchText(`https://${host}/r/${source.sub}/new/.rss?limit=25`)));
    } catch {
      // try the next host
    }
  }
  throw new SkipError('Reddit blocks this server without app keys');
}

async function fetchReddit(source) {
  const token = await getRedditToken();
  if (!token) return fetchRedditAnonymous(source);
  const res = await fetch(`https://oauth.reddit.com/r/${source.sub}/new?limit=25&raw_json=1`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const entries = (data?.data?.children || [])
    .map((c) => c.data)
    .filter((p) => p && !p.stickied)
    .map((p) => ({
      id: p.name,
      title: p.title,
      url: `https://www.reddit.com${p.permalink}`,
      summary: [p.link_flair_text, p.selftext].filter(Boolean).join(' · '),
      published: new Date(p.created_utc * 1000),
    }));
  return finish(source, entries);
}

async function fetchBluesky(account) {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(account.handle)}&limit=20&filter=posts_no_replies`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const source = { name: `Bluesky @${account.handle}`, kind: 'bluesky', scene: account.scene || 'auto' };
  const entries = (data.feed || [])
    .filter((f) => !f.reason) // skip reposts
    .map((f) => {
      const post = f.post;
      const rkey = String(post.uri).split('/').pop();
      const text = post.record?.text || '';
      return {
        id: post.uri,
        title: text.split('\n')[0].slice(0, 200),
        url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
        summary: text,
        published: parseDate(post.record?.createdAt),
      };
    });
  return finish(source, entries);
}

export function buildJobs(config) {
  const jobs = config.sources.map((s) => {
    const run = { rss: fetchRss, google: fetchGoogle, reddit: fetchReddit }[s.type];
    if (!run) throw new Error(`Unknown source type "${s.type}" for ${s.name}`);
    return { name: s.name, run: () => run(s) };
  });
  for (const acct of config.bluesky?.accounts || []) {
    jobs.push({ name: `Bluesky @${acct.handle}`, run: () => fetchBluesky(acct) });
  }
  return jobs;
}

export async function runJobs(jobs) {
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  return results.map((r, i) => ({
    name: jobs[i].name,
    ok: r.status === 'fulfilled',
    skipped: r.status === 'rejected' && r.reason instanceof SkipError,
    items: r.status === 'fulfilled' ? r.value : [],
    error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : null,
  }));
}
