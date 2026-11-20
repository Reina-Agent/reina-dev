// CJK-aware search-term tokenization for the workspace search indexes.
//
// FTS5's unicode61 tokenizer treats a run of Chinese as ONE token, so any
// CJK query used to bypass FTS entirely and fall back to an unbounded LIKE
// scan. This module ports kimi-code's minidb tokenizer (text-index.ts): latin
// and number words plus CJK unigrams AND bigrams — no dictionary, no
// segmenter, zero dependencies. The index side stores the space-joined term
// set in a contentless FTS5 table (see SEARCH_TERMS_SCHEMA + the
// `reina_search_terms` SQL function registered by SessionStore.open); the
// query side transforms the user's query with the SAME rule into an
// AND-of-terms MATCH expression, so a two-character Chinese word — the most
// common query shape — is a single indexed bigram lookup.

const LATIN_RUN = /[a-z0-9]+/g;
// Union of the CJK ranges the session-store CJK detector routes away from
// unicode61: kana, CJK ext-A + unified ideographs, hangul syllables,
// compatibility ideographs, and halfwidth/fullwidth forms.
const CJK_RUN = /[぀-ヿ㐀-鿿가-힯豈-﫿＀-￯]+/g;
// Drop pathological single tokens (a base64 blob "word") — they can never be
// real query terms and only bloat the index. Mirrors kimi's MAX_TERM_CHARS
// guard, scaled to sane query lengths.
const MAX_LATIN_TERM_CHARS = 64;

/** Index-side tokenization: the space-joined, deduplicated term set for one
 * document. Term ORDER is irrelevant — queries are AND-of-terms, never
 * phrases — so deduping keeps the index small for CJK-heavy text. */
export function searchTerms(text: unknown): string {
  const s = String(text ?? "").toLowerCase();
  const seen = new Set<string>();
  for (const word of s.match(LATIN_RUN) ?? []) {
    if (word.length <= MAX_LATIN_TERM_CHARS) seen.add(word);
  }
  for (const run of s.match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length; i++) {
      seen.add(run[i]!);
      if (i + 1 < run.length) seen.add(run[i]! + run[i + 1]!);
    }
  }
  return [...seen].join(" ");
}

/** Query-side transform: the FTS5 MATCH expression for a user query, or null
 * when the query yields no usable terms (pure punctuation). Latin words match
 * by prefix (`"compact"*` hits "compaction" — approximating the LIKE
 * substring semantics this path replaces); CJK runs of length ≥2 become an
 * AND of their bigrams, a single CJK char matches its indexed unigram. */
export function searchMatchQuery(query: unknown): string | null {
  const s = String(query ?? "").toLowerCase();
  const terms = new Set<string>();
  for (const word of s.match(LATIN_RUN) ?? []) {
    if (word.length <= MAX_LATIN_TERM_CHARS) terms.add(`"${word}"*`);
  }
  for (const run of s.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      terms.add(`"${run}"`);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) {
      terms.add(`"${run[i]}${run[i + 1]}"`);
    }
  }
  if (terms.size === 0) return null;
  return [...terms].join(" AND ");
}
