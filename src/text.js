// Small text helpers: whole-word matching, cleanup, and title similarity.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from',
  'is', 'are', 'was', 'were', 'be', 'as', 'it', 'its', 'this', 'that', 'after', 'over', 'into',
  'his', 'her', 'their', 'has', 'have', 'had', 'vs', 'v', 'new', 'just',
]);

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&#8217;': "'", '&#8216;': "'", '&#8220;': '"', '&#8221;': '"', '&#8211;': '-', '&#8212;': '-',
};

export function stripHtml(value) {
  if (value == null) return '';
  let text = String(value);
  text = text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  text = text.replace(/<[^>]*>/g, ' ');
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  text = text.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ');
  return text.replace(/\s+/g, ' ').trim();
}

const regexCache = new Map();

function termRegex(term) {
  let re = regexCache.get(term);
  if (!re) {
    const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // Whole-word: not preceded or followed by a letter or digit.
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    regexCache.set(term, re);
  }
  return re;
}

export function hasTerm(text, term) {
  if (!text) return false;
  return termRegex(term).test(text);
}

export function matchTerms(text, terms) {
  return terms.filter((t) => hasTerm(text, t));
}

export function tokens(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// Google News titles end with " - Publisher". Split it off.
export function splitPublisher(title) {
  const m = String(title || '').match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
  return m ? { title: m[1], publisher: m[2].trim() } : { title: String(title || ''), publisher: null };
}

export function truncate(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}
