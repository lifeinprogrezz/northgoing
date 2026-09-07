// Pins the canonical-url rules (scripts/canon-url.mjs) that run on every scraped
// row before the jobs upsert. jobs.url is UNIQUE, so each rule here is one
// duplicate class measured in production on 2026-09-07 (personio .com/.de 285
// pairs, trailing slash 9 groups, case residue ~77). The merge migration
// 20260907191000_merge_url_variant_rows.sql mirrors these rules in SQL; keep
// the two in step. Pure function, no network.
import { describe, expect, it } from "vitest";
import { canonUrl } from "../../scripts/canon-url.mjs";

describe("query strip + lowercase on the five ATS hosts", () => {
  it.each([
    ["lever", "https://jobs.lever.co/Perk/AbC-123?lever-source=LinkedIn#apply", "https://jobs.lever.co/perk/abc-123"],
    ["ashby", "https://jobs.ashbyhq.com/TravelPerk/9F1E?utm_source=x", "https://jobs.ashbyhq.com/travelperk/9f1e"],
    ["workable", "https://apply.workable.com/Acme/j/ABCDEF1234/?utm_medium=y", "https://apply.workable.com/acme/j/abcdef1234"],
    ["smartrecruiters", "https://jobs.smartrecruiters.com/Acme/743999?trid=1", "https://jobs.smartrecruiters.com/acme/743999"],
    ["breezy", "https://acme.breezy.hr/p/ABC123-product-manager?source=li", "https://acme.breezy.hr/p/abc123-product-manager"],
  ])("%s: drops ?query and #fragment and lowercases the path", (_host, input, expected) => {
    expect(canonUrl(input)).toBe(expected);
  });
});

describe("greenhouse is exempt", () => {
  it("keeps the query (embedded boards need ?gh_jid=) and the path case", () => {
    const u = "https://boards.greenhouse.io/Acme/jobs/4012345?gh_jid=4012345";
    expect(canonUrl(u)).toBe(u);
  });
});

describe("personio host fold", () => {
  it("rewrites X.jobs.personio.com to X.jobs.personio.de, the form sources/personio.mjs emits", () => {
    expect(canonUrl("https://vytal.jobs.personio.com/job/1234567")).toBe("https://vytal.jobs.personio.de/job/1234567");
  });

  it("leaves a .de url alone", () => {
    const u = "https://vytal.jobs.personio.de/job/1234567";
    expect(canonUrl(u)).toBe(u);
  });

  it("keeps the query on personio (it is not one of the strip hosts)", () => {
    expect(canonUrl("https://vytal.jobs.personio.com/job/1234567?language=en")).toBe(
      "https://vytal.jobs.personio.de/job/1234567?language=en",
    );
  });
});

describe("trailing slash", () => {
  it("strips the trailing slash from a path longer than / on any host", () => {
    expect(canonUrl("https://nordsecurity.com/careers/8b1c2d3e-0000-4000-8000-000000000000/")).toBe(
      "https://nordsecurity.com/careers/8b1c2d3e-0000-4000-8000-000000000000",
    );
  });

  it("strips it before the query string too", () => {
    expect(canonUrl("https://example.com/jobs/42/?ref=startupmap")).toBe("https://example.com/jobs/42?ref=startupmap");
  });

  it("keeps the root path /", () => {
    expect(canonUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonUrl("https://example.com")).toBe("https://example.com/");
  });

  // Review round 1 (2026-09-07): the rule stripped ONE slash, so "/a//" canonicalized
  // to "/a/" and a second pass to "/a". The merge migration mirrors the rule and
  // claims a rerun is a no-op; on a double-slash row that took three runs. Every
  // trailing slash goes now, and canonUrl is a fixpoint.
  it("strips every trailing slash, not just one", () => {
    expect(canonUrl("https://acme.com/careers/y//")).toBe("https://acme.com/careers/y");
    expect(canonUrl("https://acme.com/careers/y///?ref=x")).toBe("https://acme.com/careers/y?ref=x");
    expect(canonUrl("https://example.com//")).toBe("https://example.com/");
  });

  it("is a fixpoint: canonUrl(canonUrl(u)) equals canonUrl(u)", () => {
    for (const u of FIXPOINT_CORPUS) {
      const once = canonUrl(u);
      expect(canonUrl(once), u).toBe(once);
    }
  });
});

/** Every input the rules above touch, plus the double-slash straggler that broke rerun. */
const FIXPOINT_CORPUS = [
  "https://jobs.lever.co/Perk/AbC-123?lever-source=LinkedIn#apply",
  "https://jobs.ashbyhq.com/TravelPerk/9F1E?utm_source=x",
  "https://apply.workable.com/Acme/j/ABCDEF1234/?utm_medium=y",
  "https://boards.greenhouse.io/Acme/jobs/4012345?gh_jid=4012345",
  "https://vytal.jobs.personio.com/job/1234567?language=en",
  "https://nordsecurity.com/careers/8b1c2d3e-0000-4000-8000-000000000000/",
  "https://example.com/jobs/42/?ref=startupmap",
  "https://acme.com/careers/y//",
  "https://example.com//",
  "https://example.com/",
];

describe("non-url input", () => {
  it("returns anything new URL rejects unchanged", () => {
    expect(canonUrl("not a url")).toBe("not a url");
    expect(canonUrl("")).toBe("");
  });
});
