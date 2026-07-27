# Adapter Expansion — next sprint

> **Status update**: the Google (§2) and Microsoft (§3) sections below have
> since shipped — both are live in `Build Requests`/`Parse Jobs` as
> single-company bespoke integrations. Kept here as the research record
> (real endpoint shapes, live-verified) rather than deleted. Still open:
> Meta (§1), Workday tenant bulk expansion (§4), and SmartRecruiters/Eightfold
> tenant discovery (§5) — see the renumbered priority order in §7.

Design doc for the poller adapters explicitly deferred out of the 2026-07-15
find_jobs fix wave. Scope: Meta/Google/Microsoft custom adapters, Workday
tenant bulk expansion, and the SmartRecruiters/Eightfold discovery problem.
Google and Microsoft are now shipped (see status note above); the rest of
this doc is still an accurate plan, not shipped code.

**Every endpoint shape below is written from training data (cutoff January
2026) and MUST be live-verified — a real request against the real endpoint,
not assumed — before writing a single line of adapter code.** This project's
own history is full of exactly this kind of drift: B2 (2026-07-10) caught
`visa.wd1` in the codebase's own `COHORT_TARGETS` table when the real tenant
was `visa.wd5`; the same session found 2 of 2 guessed company slugs
(Goldman Sachs, Tesla) were simply wrong on live verification. Assume the
same failure rate here until proven otherwise.

## 1. Meta (metacareers.com)

**Believed shape** (verify first): a GraphQL POST endpoint behind
`metacareers.com/graphql`, cursor-paginated, requiring a `doc_id` that
changes across Meta's own frontend deploys (Relay-style persisted queries —
these `doc_id` values are NOT stable and will need periodic re-discovery,
unlike a normal versioned REST API). Likely needs a `fb_dtsg` or similar
CSRF-style token pulled from an initial page load, which raises the
implementation bar above every existing adapter (all of which are stateless
single-request or simple-pagination calls).

**Bot-detection risk**: Meta's careers site is far more likely to rate-limit
or challenge a non-browser client than any adapter this codebase has today
(Workday/Ashby/Greenhouse have no such history in this project). Treat this
as the highest-risk, highest-maintenance adapter in this doc.

**Recommendation**: verify the GraphQL shape with a real browser
network-tab capture before writing any code. If the token/doc_id churn rate
is high, this may not be worth building at all relative to the existing
fallback — `COHORT_TARGETS`'s `site:metacareers.com` Serper/You.com query
already surfaces Meta roles today, just without cache persistence or the
richer JD text a direct adapter would give.

## 2. Google (careers.google.com)

**Believed shape**: a JSON search API (something like
`careers.google.com/api/v3/search/`) accepting `query`, `location`,
pagination cursor/page params, and returning structured job objects with
title/location/description fields directly — no HTML scraping needed if this
holds. Historically closer to a normal REST search API than Meta's GraphQL
layer, so likely a LOWER implementation bar.

**Recommendation**: verify the exact path and param names first (these APIs
get restructured without notice). If the shape matches expectations, this is
a good SECOND adapter to build after confirming the pattern works at all —
lower risk than Meta, high job volume.

## 3. Microsoft (careers.microsoft.com)

**Believed shape**: a search API on a `gcsservices.careers.microsoft.com` or
similar subdomain, params resembling `q` (query text), `lc` (location
code/facet), `l` (locale), and offset/page-size pagination. Response likely
a JSON array of postings with a numeric job ID, title, location, and a
posting-date field.

**Recommendation**: verify live. If the shape is a plain paginated JSON
search (no GraphQL/token complexity like Meta), this is comparable in
difficulty to the existing `smartrecruiters`/`amazon`/`oracle` single-page
adapters already in `Parse Jobs` — a good candidate for the same "parsed
straight from Fetch ATS's response" pattern (no self-fetch `require('https')`
needed) if a single GET/POST returns full or near-full results.

## 4. Workday tenant bulk expansion

This is the highest-value, LOWEST-risk item in this doc — the adapter
(`fetchWorkday` in `Parse Jobs`) already works and is proven live (72 active
Workday companies today, per B2/s68/s61 seeding waves). This is pure tenant
*discovery*, not new adapter code.

**Protocol** (established by B1/B2/s68/s61, do not deviate):
1. For a target company name, find its real Workday tenant + site name.
   Common URL shape: `https://<tenant>.wd<N>.myworkdayjobs.com/<site>` — the
   tenant and `wd<N>` (wd1 through wd12+ seen across the seeded set) are
   NOT derivable from the company name; they must be found via a real web
   search for the company's actual careers page URL.
2. **Live-verify with a real CXS API call** before adding a registry row —
   `POST https://<tenant>.wd<N>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs`
   with body `{"appliedFacets":{},"limit":1,"offset":0,"searchText":""}`.
   A real `total` count + `jobPostings` array confirms the tenant/site pair;
   a 403/404 means the guess was wrong — do not seed a guessed pair without
   this check (B2: 2 guessed slugs failed exactly this way).
3. Add the confirmed row to the Registry Seeder's `Build Seed List` (the
   git-tracked source of truth since s78) as
   `{ name, ats_type: 'workday', slug: '<site>', api_base: '<tenant>.wd<N>' }`.

**Candidate list, NOT yet seeded, live-verify each individually**: this is a
starting shortlist of Fortune 500 / Big 4 / high-value-fintech companies
plausibly on Workday, gathered from having seen similar companies already
confirmed on this platform — treat every single one as unconfirmed:
Deloitte, EY, KPMG, PwC, Accenture, Cognizant, Capital One, American
Express, Wells Fargo, Bank of America, Goldman Sachs (confirmed NOT
reachable this way per B2 — re-verify, don't re-guess the same failure),
Chevron, ExxonMobil, Boeing, Lockheed Martin, Raytheon/RTX, Honeywell,
Johnson & Johnson, Pfizer, Merck, UnitedHealth Group, CVS Health, Verizon,
AT&T, Comcast, Disney, PepsiCo, Coca-Cola, Procter & Gamble, 3M, General
Electric, General Motors, Ford. Expect a meaningful fraction of these to
either not be on Workday at all or to require the same "test, don't guess"
treatment before any row gets added.

## 5. SmartRecruiters / Eightfold

Both platforms are architecturally ready in `Parse Jobs` (the `smartrecruiters`
branch parses `body.content`; `fetchEightfold` self-fetches with a
`smartapply`→`pcsx` fallback) — the blocker is entirely tenant discovery,
not adapter code.

**Documented finding (this codebase, prior session)**: guessed tenant IDs on
both platforms return a **200 OK with a valid-shaped but EMPTY response**
(zero postings) rather than a clean 404 — this is worse than Workday's
clear pass/fail signal, because a naive "did the request succeed" check
would wrongly treat an empty-but-wrong tenant ID as a legitimately
zero-posting company and silently never flag it as a bad guess.

**What a correct discovery path looks like**: never derive a tenant ID from
a company name. Find the company's REAL live careers-page URL first (a web
search, not a guess), confirm it resolves through `jobs.smartrecruiters.com/<id>`
or the Eightfold-hosted domain pattern, and only then treat that URL's own
tenant segment as ground truth. Given the empty-response failure mode above,
a discovery script for these two platforms should always check for at least
one NON-ZERO posting in the response before accepting a candidate ID, not
just a 200 status.

## 6. Poller integration checklist

Hard-won lessons from the existing self-fetch adapters (workday/apple/
eightfold/avature) — apply all of these to any NEW adapter that needs the
same treatment:

- **Sandbox**: n8n Code nodes have no global `fetch`/`URL`. Any new adapter
  needing more than a single `Fetch ATS` GET/POST (pagination, custom
  headers, a token round-trip) must hand-roll HTTP via `require('https')`,
  same pattern as `fetchWorkday`/`fetchApple`/`fetchEightfold`/`fetchAvature`
  in `Parse Jobs`.
- **Self-fetch registration**: any adapter type that bypasses `Fetch ATS`
  entirely (rather than parsing its response) must be added to BOTH:
  `Parse Jobs`' `selfFetchCompanies` filter (`ats_type === 'workday' ||
  'apple' || 'eightfold' || 'avature'`, currently) AND `Tick Bookkeeping`'s
  `SELF_FETCH_TYPES` set — missing either one reintroduces the exact B1 bug
  (`Tick Bookkeeping` judging a self-fetch type's success off `Fetch ATS`'s
  designed-to-fail throwaway URL, silently deactivating a working company
  after 5 strikes).
- **The `{rows, ok}` contract**: every self-fetch function must return
  `{ rows: [...], ok: boolean }` — `ok` means "the endpoint responded in a
  way we understood" (even if `rows` is legitimately empty), NOT "we found
  postings." `Parse Jobs` stores this in
  `$getWorkflowStaticData('global').self_fetch_outcomes`, keyed by board;
  `Tick Bookkeeping` reads it for self-fetch types instead of `Fetch ATS`'s
  status.
- **Single-company adapter rule**: `amazon`/`apple`/`oracle` are hardcoded
  single-tenant integrations in `Parse Jobs`/`Build Requests`, not generic
  multi-tenant adapter types — a second `ats_type: 'amazon'` row would
  mislabel/misroute (confirmed via code read, B2). Meta/Google/Microsoft
  adapters, being similarly single-company, should follow this SAME pattern
  (a dedicated `ats_type` per company, not a generic reusable type) unless a
  genuinely multi-tenant version of the same platform exists elsewhere.
- **Ingest vocabulary reuse**: the config-driven title filter shipped in
  this same fix wave (`app_settings.ingest_title_filter`, see
  `scripts/applied/s91_ingest_title_filter.js`) already gates every adapter's
  output uniformly via `push()` — a new adapter needs zero additional
  filtering logic of its own, just call the existing `push(board, obj)`.
- **Fixture capture**: `fixtures/` holds raw captured responses per adapter
  (`stripe_gh.json`, `lever_spotify.json`, `ashby_ramp.json`, `wd_detail.json`,
  `wd_kainos.json`, `wk_widget.json`, `wk_www.json`) — referenced by nothing
  in the live codebase, kept only as manual test fixtures per
  `fixtures/README.md`. Capture one real response per new adapter the same
  way before wiring it into `Parse Jobs`, so the parsing logic is written
  against real data, not assumed shape.

## 7. Prioritization

Rough build-cost-vs-value ordering, cost estimated from the above. Google
and Microsoft (formerly priorities 2-3) have shipped — see the status note
at the top of this doc.

1. **Workday tenant bulk expansion** — near-zero new code (adapter already
   works), pure discovery-and-seed work, highest confidence of success.
   Do this first, and do it incrementally (verify-then-seed one tenant at a
   time, per the existing B2 protocol) rather than a big batch.
2. **SmartRecruiters / Eightfold tenant discovery** — code is ready, this is
   pure research work (find real tenant IDs the safe way, watch for the
   empty-response-on-wrong-ID trap). Worth doing opportunistically as
   specific companies come up rather than as a dedicated sprint.
3. **Meta** — highest implementation cost (GraphQL, likely token handling,
   real bot-detection risk) for a company already reachable today via the
   existing `site:metacareers.com` Serper/You.com fallback. Lowest priority;
   reconsider only if the fallback proves clearly insufficient in practice.
