// Canonical posting url, applied to EVERY scraped row before the jobs upsert
// (scripts/scrape.mjs). jobs.url is UNIQUE, so two spellings of the same
// posting become two rows, each scored again per user and shown twice.
// Extracted from scrape.mjs on 2026-09-07 so the rules are pinned by
// src/test/canon-url.test.ts and mirrored 1:1 by the one-time merge migration
// (supabase/migrations/20260907191000_merge_url_variant_rows.sql). Change a
// rule here and in that SQL together.
//
// Rules, in the order they apply:
//   1. Personio: `X.jobs.personio.com` -> `X.jobs.personio.de`. sources/personio.mjs
//      emits `.de` (personioHost; the `.com` mirror serves the identical document),
//      startupmap emits `.com` for the same posting: 285 duplicate pairs measured on
//      2026-09-07.
//   2. lever / ashby / workable / smartrecruiters / breezy: drop the query string and
//      fragment (tracking suffixes such as ?lever-source=..., utm: the 01Health/32Co
//      class) and lowercase the path. Ashby/Lever board tokens are case-insensitive:
//      /perk/UUID and /Perk/UUID are the SAME posting (the Perk / TravelPerk class:
//      one company scraped under two board-name casings). Greenhouse is exempt: its
//      embedded boards need ?gh_jid=, and its paths are case-sensitive.
//   3. Every host: strip ONE trailing slash from a path longer than "/"
//      (`/careers/<uuid>/` vs `/careers/<uuid>`, nordsecurity via startupmap, 9
//      groups). The root path stays "/".
// Anything `new URL` rejects is returned unchanged: a bad url is a source bug to
// surface downstream, not something to guess at here.

const STRIP_QUERY_HOSTS = [/(^|\.)lever\.co$/, /(^|\.)ashbyhq\.com$/, /(^|\.)workable\.com$/, /(^|\.)smartrecruiters\.com$/, /(^|\.)breezy\.hr$/];
const PERSONIO_COM_HOST = /\.jobs\.personio\.com$/;

export function canonUrl(u) {
  try {
    const x = new URL(u);
    if (PERSONIO_COM_HOST.test(x.hostname)) {
      x.hostname = x.hostname.replace(PERSONIO_COM_HOST, ".jobs.personio.de");
    }
    if (STRIP_QUERY_HOSTS.some((re) => re.test(x.hostname))) {
      x.search = "";
      x.hash = "";
      x.pathname = x.pathname.toLowerCase();
    }
    if (x.pathname.length > 1 && x.pathname.endsWith("/")) {
      x.pathname = x.pathname.slice(0, -1);
    }
    return x.toString();
  } catch { return u; }
}
