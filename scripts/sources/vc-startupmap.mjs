#!/usr/bin/env node
/**
 * scripts/sources/vc-startupmap.mjs — VC-portfolio job boards + startupmap.one
 * as fetch-only sources for the daily scrape (scripts/scrape.mjs).
 *
 * Ported from the career-ops engine's Playwright scrapers
 * (scaling-europe-scan / a16z-scan / lsvp-scan / phoenix-court-scan /
 * balderton-scan / creandum-scan / getro-vc-scan / startupmap-jobs-scan).
 * The web-app scrape pipeline has NO Playwright dependency (it runs in a
 * GitHub Actions cron over plain fetch), so each board is re-implemented
 * against the underlying JSON / REST API the SPA itself calls — endpoints
 * captured live from the network panel on 2026-06-14:
 *
 *   - Scaling Europe → its public Supabase REST table  (GET + anon key)
 *   - a16z / LSVP / Phoenix Court / Balderton / Creandum → the consider.com
 *     board API  POST /api-boards/search-jobs  (the platform all five run on)
 *   - Getro (Entrepreneur First + Atomico + Cherry) → the Getro collections
 *     API  POST https://api.getro.com/api/v2/collections/<id>/search/jobs
 *   - startupmap.one → GET /api/jobs + GET /api/startups  (FK join on startup_id)
 *
 * CONTRACT (shared with scripts/scrape.mjs): every emitted job is
 *   { company, title, url, location, remote, source, posted_at, jd_text, seniority }
 * and is kept only when isInScope(title) AND isEU(location) — the five role_family
 * verticals since #34, not PM-only. seniority = inferSeniority(title).
 * jd_text is null for these boards — none expose the JD body in their list API
 * (the apply URL is ATS-direct, so the body is fetched downstream at score time,
 * same as scrape.mjs does for Meta/Apple). We never fabricate a body.
 *
 * EXPORT: `sources` — one descriptor { company, run } per board (+ startupmap).
 * The orchestrator in scrape.mjs spreads these into SOURCES alongside the
 * Greenhouse/Lever/Ashby boards. `run()` returns the filtered EU-PM array.
 */
import { isInScope, isEU, inferSeniority, stripHtml, FAMILY_SEED_QUERIES } from "../job-filters.mjs";
import { resolveGetroJobs } from "../getro-lib.mjs";
import { pfetch } from "./_proxy.mjs";

const TIMEOUT_MS = 20_000;
const fetchOpts = (extra = {}) => ({ signal: AbortSignal.timeout(TIMEOUT_MS), ...extra });
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── Scaling Europe ──────────────────────────────────────────────────────────
// https://scalingeurope.co.uk/jobs is a Vite SPA over a public Supabase project.
// The page issues an anon-key GET against the `jobs` table; we call the same
// endpoint directly. The key below is the project's publishable anon key
// (shipped to every browser that loads the site) — not a secret.
const SCALING_EUROPE = {
  base: "https://yaionvwehtkrqgtjzdqn.supabase.co/rest/v1/jobs",
  anonKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlhaW9udndlaHRrcnFndGp6ZHFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1MTE4MjAsImV4cCI6MjA4OTA4NzgyMH0.1FahdfqyoL9k0OEMk8Z2ig3Hkhc78GpORax0uRoKvOY",
};

async function fetchScalingEurope() {
  const params = new URLSearchParams({
    select: "company_name,company_slug,title,location,job_type,team,url,first_seen_at",
    removed_at: "is.null",
    order: "first_seen_at.desc",
    limit: "1000",
  });
  const res = await fetch(`${SCALING_EUROPE.base}?${params}`, fetchOpts({
    headers: {
      apikey: SCALING_EUROPE.anonKey,
      Authorization: `Bearer ${SCALING_EUROPE.anonKey}`,
      "Accept-Profile": "public",
    },
  }));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.url && isInScope(r.title))
    .map((r) => {
      const location = r.location || null;
      return {
        company: r.company_name || null,
        title: r.title,
        url: r.url,
        location,
        remote: /remote/i.test(location || "") || /remote/i.test(r.title || ""),
        source: "scaling-europe",
        posted_at: r.first_seen_at || null,
        jd_text: null,
        seniority: inferSeniority(r.title),
      };
    })
    .filter((j) => isEU(j.location));
}

// ─── consider.com boards (a16z / LSVP / Phoenix Court / Balderton / Creandum) ──
// All five run on the consider.com job-board platform. The SPA POSTs to
// <host>/api-boards/search-jobs with { meta:{size,sequence}, board:{id,isParent},
// query:{jobTypes,locations,promoteFeatured} } and gets back
// { jobs:[...], total, meta:{sequence} }. We page via the opaque meta.sequence
// cursor until we've drained `total` (or hit a safety page cap). The board `id`
// (slug) is NOT the hostname — it was read from each board's bootstrap JSON
// (e.g. localglobe-all for Phoenix Court). Each job carries the ATS-direct
// applyUrl; the JD body is not in the list payload (jd_text stays null).
const CONSIDER_BOARDS = [
  { name: "a16z",          source: "vc:a16z",          host: "jobs.a16z.com",         slug: "andreessen-horowitz" },
  { name: "LSVP",          source: "vc:lsvp",          host: "jobs.lsvp.com",          slug: "lightspeed" },
  { name: "Phoenix Court", source: "vc:phoenix-court", host: "jobs.phoenixcourt.vc",   slug: "localglobe-all" },
  { name: "Balderton",     source: "vc:balderton",     host: "careers.balderton.com",  slug: "balderton-capital" },
  { name: "Creandum",      source: "vc:creandum",      host: "careers.creandum.com",   slug: "creandum" },
];
const CONSIDER_PAGE_SIZE = 100; // platform returns up to this many per page
// All-vertical (#34): the jobTypes:["product-manager"] facet is GONE — the boards
// now return every function and isInScope() narrows locally, so the safety bound
// grows to cover full-board totals (drain still early-stops on `total`).
const CONSIDER_MAX_PAGES = 30;

async function fetchConsiderBoard(board) {
  const endpoint = `https://${board.host}/api-boards/search-jobs`;
  const collected = [];
  let sequence = null;
  for (let page = 0; page < CONSIDER_MAX_PAGES; page++) {
    const meta = sequence ? { size: CONSIDER_PAGE_SIZE, sequence } : { size: CONSIDER_PAGE_SIZE };
    const body = {
      meta,
      board: { id: board.slug, isParent: true },
      query: { jobTypes: [], locations: ["Europe"], promoteFeatured: true },
    };
    const res = await fetch(endpoint, fetchOpts({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
        Origin: `https://${board.host}`,
        Referer: `https://${board.host}/jobs`,
      },
      body: JSON.stringify(body),
    }));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const jobs = data.jobs || [];
    collected.push(...jobs);
    sequence = data.meta && data.meta.sequence;
    const total = typeof data.total === "number" ? data.total : collected.length;
    if (!sequence || jobs.length === 0 || collected.length >= total) break;
  }
  return collected
    .filter((j) => isInScope(j.title))
    .map((j) => {
      const location = Array.isArray(j.locations) ? j.locations.join(", ") : j.locations || null;
      return {
        company: j.companyName || j.companyId || null,
        title: j.title,
        url: j.applyUrl || j.url,
        location,
        remote: !!j.remote || /remote/i.test(location || "") || /remote/i.test(j.title || ""),
        source: board.source,
        posted_at: j.timeStamp || null,
        jd_text: null,
        seniority: inferSeniority(j.title),
      };
    })
    .filter((j) => j.url && isEU(j.location));
}

// All five consider boards merged into one descriptor's run() so they share a
// single failure boundary the way career-ops bundled them per-platform; each
// row keeps its own `source` tag.
async function fetchAllConsider() {
  const all = [];
  for (const board of CONSIDER_BOARDS) {
    try {
      const jobs = await fetchConsiderBoard(board);
      all.push(...jobs);
    } catch (e) {
      console.error(`  ${board.name} (consider) failed: ${e.message}`);
    }
  }
  return all;
}

// ─── Getro boards (Entrepreneur First + Atomico + Cherry) ─────────────────────
// The getro-vc board in career-ops bundles three Getro-platform VC boards. Each
// SPA POSTs to api.getro.com/api/v2/collections/<id>/search/jobs with
// { hitsPerPage, page, query, filters } and gets { results:{ jobs:[...], count } }.
// The API caps each page at ~20 regardless of hitsPerPage, and `query` is a loose
// full-text match (so `count` is large) — we fetch a bounded number of pages and
// let the strict isInScope(title) filter do the narrowing. Job carries the ATS-direct
// `url`, `organization.name`, `locations[]`, and `created_at` (UNIX seconds).
const GETRO_BOARDS = [
  { name: "Entrepreneur First", source: "vc:getro:ef",      collectionId: 228,   origin: "https://portfolio.joinef.com" },
  { name: "Atomico",            source: "vc:getro:atomico", collectionId: 36986, origin: "https://careers.atomico.com" },
  { name: "Cherry",             source: "vc:getro:cherry",  collectionId: 44081, origin: "https://talent.cherry.vc" },
];
const GETRO_HITS_PER_PAGE = 100;
const GETRO_MAX_PAGES = 4; // per QUERY; API returns ~20/page — 4 pages per family seed query drains each family's real tail

async function fetchGetroBoard(board) {
  const endpoint = `https://api.getro.com/api/v2/collections/${board.collectionId}/search/jobs`;
  const collected = [];
  // All-vertical (#34): one loose full-text query per family; the strict
  // isInScope(title) filter below does the precision work.
  for (const query of FAMILY_SEED_QUERIES) {
    for (let page = 0; page < GETRO_MAX_PAGES; page++) {
      const res = await fetch(endpoint, fetchOpts({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": UA,
          Origin: board.origin,
          Referer: `${board.origin}/`,
        },
        body: JSON.stringify({ hitsPerPage: GETRO_HITS_PER_PAGE, page, query, filters: {} }),
      }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const jobs = (data.results && data.results.jobs) || [];
      if (jobs.length === 0) break;
      collected.push(...jobs);
    }
  }
  return collected
    .filter((j) => isInScope(j.title))
    .map((j) => {
      const location = Array.isArray(j.locations)
        ? j.locations.join(", ")
        : (Array.isArray(j.searchable_locations) ? j.searchable_locations.join(", ") : j.locations || null);
      const postedAt = Number.isFinite(j.created_at)
        ? new Date(j.created_at * 1000).toISOString()
        : null;
      return {
        company: (j.organization && j.organization.name) || null,
        title: j.title,
        url: j.url,
        location,
        remote: /remote/i.test(j.work_mode || "") || /remote/i.test(location || "") || /remote/i.test(j.title || ""),
        source: board.source,
        posted_at: postedAt,
        jd_text: null,
        seniority: inferSeniority(j.title),
      };
    })
    .filter((j) => j.url && isEU(j.location));
}

async function fetchAllGetro() {
  const all = [];
  const seen = new Set();
  for (const board of GETRO_BOARDS) {
    try {
      const raw = await fetchGetroBoard(board);
      // Getro boards emit LinkedIn URLs, some with WRONG company attribution
      // (issue #68 item 2 — the Beekeeper→LumApps / Passfort→Moody's class).
      // ATS-direct rows pass through; LinkedIn rows are re-attributed to the
      // company named in the URL slug or dropped. See scripts/getro-lib.mjs.
      const { jobs, reattributed, dropped } = resolveGetroJobs(raw);
      if (reattributed || dropped) {
        console.error(`  ${board.name} (getro): re-attributed ${reattributed}, dropped ${dropped} unresolvable LinkedIn row(s)`);
      }
      for (const j of jobs) {
        // The three Getro VCs overlap in portfolio; dedup by URL within the board.
        const key = (j.url || "").split("?")[0].split("#")[0].toLowerCase();
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        all.push(j);
      }
    } catch (e) {
      console.error(`  ${board.name} (getro) failed: ${e.message}`);
    }
  }
  return all;
}

// ─── startupmap.one ──────────────────────────────────────────────────────────
// Plain GET, no auth. /api/jobs returns the full catalog (each job has a
// startup_id FK); /api/startups returns the company directory. We join the two
// to recover the company name + a city fallback, prefer the ATS-direct apply_url,
// and date from posted_at/first_seen_at/created_at when present.
const STARTUPMAP_BASE = "https://startupmap.one";

// Resilience (2026-09-07): startupmap failed in 10 of the last 40 scrape runs,
// 6 as "fetch failed" through the residential proxy and 4 as the 20 s timeout on
// the ~6k-job /api/jobs payload. A failed day contributes zero rows and the run
// stays green, so the loss was silent. The two catalogue GETs now get a 90 s
// timeout each and up to 3 attempts with a 2 s then 8 s backoff. A 4xx is a
// block (datacenter IP, see _proxy.mjs), not a hiccup: it throws on the first
// response and is never retried. Every failed attempt logs one WARN line to
// stderr; after the last one the helper throws the same error scrape.mjs
// already logs ("startups HTTP n" / "jobs HTTP n" / the fetch error itself).
// fetchImpl and sleep are injectable so src/test/startupmap-retry.test.ts needs
// no network and no real clock. The other boards keep the 20 s TIMEOUT_MS.
export const STARTUPMAP_TIMEOUT_MS = 90_000;
export const STARTUPMAP_ATTEMPTS = 3;
export const STARTUPMAP_BACKOFF_MS = [2_000, 8_000];
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchStartupmapEndpoint(name, headers, { fetchImpl, sleep }) {
  const url = `${STARTUPMAP_BASE}/api/${name}`;
  for (let attempt = 1; ; attempt++) {
    let res = null;
    let error = null;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(STARTUPMAP_TIMEOUT_MS) });
    } catch (e) {
      error = e; // proxy / network / timeout: a hiccup, retried
    }
    if (res && res.ok) return res;
    if (res) {
      error = new Error(`${name} HTTP ${res.status}`);
      if (res.status >= 400 && res.status < 500) throw error; // a block, not a hiccup: never retried
    }
    console.error(`  WARN startupmap /api/${name} attempt ${attempt}/${STARTUPMAP_ATTEMPTS} failed: ${error.message}`);
    if (attempt >= STARTUPMAP_ATTEMPTS) throw error;
    await sleep(STARTUPMAP_BACKOFF_MS[attempt - 1]);
  }
}

function extractArray(payload, keyHint) {
  if (Array.isArray(payload)) return payload;
  if (keyHint && Array.isArray(payload[keyHint])) return payload[keyHint];
  for (const k of Object.keys(payload || {})) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  return [];
}

export async function fetchStartupmap({ fetchImpl = pfetch, sleep = sleepMs } = {}) {
  const headers = { "User-Agent": "career-ops/1.0 (+lifeinprogrezz personal)" };
  const [cosRes, jobsRes] = await Promise.all([
    fetchStartupmapEndpoint("startups", headers, { fetchImpl, sleep }),
    fetchStartupmapEndpoint("jobs", headers, { fetchImpl, sleep }),
  ]);
  const companies = extractArray(await cosRes.json(), "startups");
  const companiesById = new Map(companies.map((c) => [c.startup_id, c]));
  const jobs = extractArray(await jobsRes.json(), "jobs");

  return jobs
    .filter((j) => j.visible !== false && isInScope(j.job_title))
    .map((j) => {
      const co = companiesById.get(j.startup_id);
      const location =
        j.job_location ||
        [co && co.office_city, j.job_country || (co && co.country)].filter(Boolean).join(", ") ||
        null;
      const startupmapUrl = j.jobs_id ? `${STARTUPMAP_BASE}/job/${j.jobs_id}` : `${STARTUPMAP_BASE}/jobs`;
      const posted = j.posted_at || j.first_seen_at || j.created_at || null;
      return {
        company: (co && co.name) || null,
        title: j.job_title,
        url: j.apply_url || startupmapUrl,
        location,
        remote: /remote/i.test(location || "") || /remote/i.test(j.job_title || ""),
        source: "startupmap",
        posted_at: posted ? String(posted).slice(0, 10) : null,
        jd_text: null,
        seniority: inferSeniority(j.job_title),
      };
    })
    .filter((j) => j.url && isEU(j.location));
}

// ─── Source descriptors ──────────────────────────────────────────────────────
// One descriptor per board (Scaling Europe · consider-five · Getro-three ·
// startupmap). `company` is the descriptor label scrape.mjs logs by; `run()`
// returns the filtered EU-PM array. The orchestrator spreads `sources` into
// SOURCES, so each runs under scrape.mjs's per-source try/catch + concurrency.
export const sources = [
  { company: "Scaling Europe (VC board)", run: fetchScalingEurope },
  { company: "Consider VC boards (a16z/LSVP/Phoenix Court/Balderton/Creandum)", run: fetchAllConsider },
  { company: "Getro VC boards (EF/Atomico/Cherry)", run: fetchAllGetro },
  { company: "startupmap.one", run: fetchStartupmap },
];

export default sources;

// Standalone smoke run: `node scripts/sources/vc-startupmap.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const all = [];
  for (const s of sources) {
    try {
      const jobs = await s.run();
      console.error(`${s.company}: ${jobs.length} EU role(s) in scope`);
      all.push(...jobs);
    } catch (e) {
      console.error(`${s.company} failed: ${e.message}`);
    }
  }
  const seen = new Set();
  const deduped = all.filter((j) => (seen.has(j.url) ? false : seen.add(j.url)));
  console.error(`Total (deduped): ${deduped.length} EU roles in scope`);
  for (const j of deduped.slice(0, 40)) {
    console.error(`  [${j.source}] ${j.company} — ${j.title} [${j.location}]`);
  }
}
