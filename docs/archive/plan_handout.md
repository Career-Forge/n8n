# CareerForge n8n — Handout for Next Steps (2026-06-14)

Continuation doc for picking this up on another machine / next session. Everything below is self-contained.

---

## 0. TL;DR — where we are

Turning the **CareerForge Telegram job bot** (n8n, self-hosted Docker) into the real product. This session shipped **S1–S3 + half of S2d, all LIVE** in the running n8n. Remaining: finish S2d (3 gated providers), then **S4–S9**. The full sprint plan + exact change-points are in §6.

- **Workflow:** "CareerForge Master — Local v6.3", id `kmQDCNypCfZbqwAW`, ~224 nodes, **active**.
- **Stack (docker, all healthy):** `careerforge_n8n`, `careerforge_postgres` (pgvector, host:5433), `careerforge_ollama` (bge-m3), `careerforge_latex` (port 5679).
- To reach the bot from Telegram you must run **ngrok** to the reserved domain (see §3).

---

## 1. The Goal (the `/goal` vision)

A Telegram bot that delivers 5 capabilities, jobright/simplify-grade:
1. **Real-time job suggestions** that are perfect matches for the master resume — accurate, with real location/salary.
2. **Tailored resume + cover letter** per job, from the LaTeX templates (command-center quality).
3. **Company intelligence** — recent funding, layoffs (layoffs.fyi), pay/toxicity, "what the team values" (Amazon LPs, Google metrics…), used both as reports AND as a match filter.
4. **Resume/CL tailored to what each company values**.
5. **High-value contact discovery** (directors/senior managers in that team+location) + cold outreach.

Scoring must be **/100** (not /10) with company research baked in.

## 2. Locked decisions (don't relitigate)
- **Distribution = open-source, self-hosted, clone-and-BYOK, SINGLE-USER per deployment.** NOT a SaaS. Each cloner uses their own API keys/credentials. Multi-tenant scalability is OUT OF SCOPE.
- **"Free + premium"** = pipeline works at two levels by which keys the cloner supplies. **Every provider + model must be independently optional and degrade gracefully** (`IF: X Disabled?` / `onError:continueRegularOutput` / empty result), documented in README/.env.
- **Shared cache** (ATS Poller → Postgres/pgvector → Ollama bge-m3 → hybrid RRF) is the free-tier backbone; live search + structured APIs are supplements.
- **Hybrid key storage:** core providers = n8n credentials (the 6 below). New optional providers = currently `app_settings` (Postgres) for speed; convert to n8n credentials in S9.

## 3. Operational quick-reference

**n8n credentials already set (BYOK):** CareerForge Postgres, Telegram, Serper (Header Auth), You.com, OpenRouter, Firecrawl.

**Run the bot live:** start ngrok to the reserved domain, then the already-registered Telegram webhook resumes:
```
ngrok http 5678 --domain=semifinal-linguini-showplace.ngrok-free.dev
```

**Deploy recipe (every workflow change):** patch the JSON on disk via a script, then:
```bash
cd careerforge_n8n
docker cp "docker/workflows/CareerForge Master Local v6.3.json" careerforge_n8n:/tmp/wf.json
MSYS_NO_PATHCONV=1 docker exec careerforge_n8n n8n import:workflow --input=/tmp/wf.json
MSYS_NO_PATHCONV=1 docker exec careerforge_n8n n8n update:workflow --id=kmQDCNypCfZbqwAW --active=true
docker restart careerforge_n8n      # required: CLI active-flag change only applies on restart; also re-registers webhook
```
Verify by re-exporting: `... n8n export:workflow --id=kmQDCNypCfZbqwAW --output=/tmp/chk.json`.

**psql:** `docker exec -i careerforge_postgres psql -U careerforge -d careerforge`

**GOTCHAS (learned the hard way):**
- **Git Bash mangles `/tmp/...` container paths** → prefix container `n8n`/`exec --output`/`--input` commands with `MSYS_NO_PATHCONV=1`. (Do NOT use it on the local `docker cp` *source* path — it breaks that.)
- **`String.replace(find, repl)` treats `$'`, `$&`, `` $` ``, `$1` as special patterns.** Our salary helper contained `'$'` → it corrupted a node. **Use `str.split(a).join(b)` for any replacement containing `$`.**
- **n8n JS Code nodes:** no `process`, `$env` unreliable → read config from `app_settings` via an upstream Postgres node, NOT `$env` in code.
- **Always harness-test new Code-node `jsCode` locally** before deploy: `new Function('$input','$', code)(mockInput, mock$)` — proven pattern, catches syntax + logic bugs.
- **Patch ALL 3 master copies:** `docker/workflows/CareerForge Master Local v6.3.json` (LIVE), `docker/workflows/CareerForge_Master_local.json`, `workflows/CareerForge_Master_local.json`.
- **Import auto-deactivates** the workflow; the `update:workflow --active=true` + `docker restart` re-activates.

**Model map (OpenRouter, BYOK; verify current at openrouter.ai/models):**
| Role | Free default | Premium |
|---|---|---|
| NL parse / query expand / job scoring / ATS (JSON-critical) | `deepseek/deepseek-v4-flash` (reliable structured output, ~$0.09/$0.18) | `google/gemini-3.5-flash` / `openai/gpt-5.4-mini` |
| Company-intel synthesis | `google/gemini-3.5-flash` | `deepseek/deepseek-v4-pro` |
| Resume / cover / outreach (quality) | `anthropic/claude-haiku-4.5` | `anthropic/claude-opus-4.8` |
| Embeddings | local Ollama `bge-m3` (free, 1024-d) | — |
Avoid: `gpt-4o`, `deepseek-chat`, `gemini-2.5-*`. (Live workflow still uses `openai/gpt-5.4-mini` on most LLM nodes — model swap is deferred to S9.)

**app_settings keys currently set:** `telegraph_token`, `adzuna_app_id`, `adzuna_app_key`.

---

## 4. Done this session — LIVE + verified

All patch scripts in `careerforge_n8n/scripts/`. Each was harness-tested then deployed.

- **S1 — Telegraph tabular view** (`s1_telegraph_token.js`). Telegraph "Full list" link works. KEY FINDING: `api.telegra.ph` is **blocked on this network** (ECONNRESET) → switched to the official mirror **`api.graph.org`** (`Telegraph CreatePage` URL). Token stored in `app_settings.telegraph_token`, read by a new `Load Telegraph Token` PG node (no `$env`).
- **S2 — location gl fix** (`s2_serper_gl.js`). `Serper Job Search` hardcoded `gl=us`; now derives from parsed `country`.
- **S2b — scorer reader fix** (`s2b_scorer_fix.js`). THE big one: `JobScorer` has a structured output parser, so results land in `$json.output`, but `Parse Scorer Output` only read `$json.text` → every run fell to a neutral 5/10 ("Scoring unavailable"). Added a Strategy-0 that reads `.output`. **Real scores now flow** (confirmed live).
- **S2c-1 — Firecrawl ATS targeting** (`s2c_firecrawl_fix.js`). `Build FC Queries` did open-web search → returned Naukri/Indeed aggregator junk (dropped by the tier classifier). Now emits deterministic `site:ATS "role" "location"` queries like You.com/Serper, fires whenever a role exists.
- **S2c2 — location truth** (`s2c2_location_truth.js`). Scorer now gets the **requested** location; returns `detected_location` + `location_match` (match/mismatch/unknown); digest shows the real/detected location (never the search-location fallback) and a "⚠ scoring degraded" banner on fallback; confident mismatches dropped for location-specific non-remote queries.
- **S2d (partial) — structured job-data lane** (`s2d_remoteok.js`, `s2d2_adzuna.js`). Canonical job object gained `salary_min/max/currency`. **RemoteOK** (keyless) + **Adzuna** (India + 19 countries, real location + salary) lanes LIVE → `Merge Sources` (now 5 inputs). `Load Structured Config` PG node reads keyed-provider creds from `app_settings`. Adzuna verified: India ML query returns ~1,300 real jobs (Hyderabad/Bangalore/Delhi). **USAJobs needs a key** (returned 401 — research was wrong that it's keyless).
- **S3 — /100 research-augmented scoring** (`s3_score100.js`). Folded a deterministic composite into `Parse Scorer Output`: LLM returns `skills_score`/`experience_score`/`workauth_score` (0-100); code adds `location` (from S2c2), `company_health` (neutral 60 until S5), `compensation` (real salary vs requested floor); weighted **Skills 35 · Exp 20 · Visa 15 · Loc 10 · Health 10 · Comp 10** → `score100`, ordinal bin (Strong≥70/Good≥55/Mixed≥40/Poor), and the **bottleneck** (weakest dim). Digest shows `NN/100` + sub-score line + weakest dim + currency-aware salary (₹ lakhs for INR). `Record Matches` stores /100.

---

## 5. Research & results (key findings)

- **Provider landscape:** You.com + Serper + Firecrawl in find-jobs all do the same `site:ATS` web search → UNSTRUCTURED, no reliable location/salary. The fix is a **structured lane** (Adzuna/RemoteOK/USAJobs/Apify/JSearch) that returns real fields. More web-search engines (Tavily/Exa/Brave/Perplexity) = diminishing returns; Brave killed its free tier (Feb 2026).
- **Native n8n nodes (2026):** Apify (official), Tavily (official), Coresignal (official), SerpApi/Serper (community), Exa/Brave (community). You.com + Firecrawl already native in the workflow.
- **Free-tier ToS reality:** per-account free tiers (You.com $100 once, Serper 2500 once, Firecrawl 1k/mo, Tavily 1k/mo, etc.) **forbid pooling across many users / commercial resale** — which is fine because this product is **clone-and-BYOK single-user** (each user uses their own accounts = personal use). The sustainable "free tier" for a multi-user product would be the **shared-cache amortization model** (the poller), but that's out of scope here.
- **Structured job sources:** Adzuna (free, India+19 ctries, GPS location+salary, ToS-ok personal) ✓ wired. RemoteOK (free public JSON, remote-only) ✓ wired. USAJobs (free key, US federal). Apify (BYOK, ATS/Google-Jobs actors, structured). JSearch (RapidAPI, Google-for-Jobs). Coresignal (native node, rich, $49/mo). Avoid LinkedIn scraping (active litigation 2026) — use Apollo for contacts instead.
- **Contacts/outreach:** the Goal-5 path is fully wired but in-workflow `ContactFinder`/`OutreachWriter` prompts are TRUNCATED vs `prompts/*.md` (OutreachWriter missing 3 of 8 rules incl. location-aware CTAs); no Apollo yet. ToS-safe hooks = GitHub API + conference talks/eng blogs + Apollo/Hunter for verified contacts.
- **Resume/cover (command-center is the gold standard):** `careerforge-command-center/supabase/functions/document-ai/index.ts` does 2-phase (select → generate LaTeX fragments) + slot-marker assembly + Pass-3 ATS + `bullet_selection_biases`. The n8n side is broken: `Build Resume LaTeX` `{{EMAIL}}` single-`.replace` (template has it twice), `$|$` math separator eaten by `$`-escaper, `Resume Output Parser` loose schema lets empty sections through, `Compile Resume PDF` `onError:continueRegularOutput` ships blank PDFs.

---

## 6. NEXT STEPS — explicit instructions

General method for each: write `scripts/sN_*.js` (clone `r7_intel_penalty.js`/`r8_values_writing.js`/`s3_score100.js` pattern → load each of the 3 master JSONs, mutate by node name with `split/join`, write back) → run it → **harness-test changed Code nodes** → deploy (§3 recipe) → verify.

### Finish S2d — gated structured providers (need keys)
- **USAJobs** (free key from developer.usajobs.gov): add `usajobs_key` to `app_settings`; new `USAJobs Fetch` (HTTP GET `data.usajobs.gov/api/search`, headers `User-Agent` + `Authorization-Key` from Load Structured Config + `Host: data.usajobs.gov`, `Keyword`/`LocationName` from Parse Expand Query) → `Normalize USAJobs` (map `SearchResult.SearchResultItems[].MatchedObjectDescriptor`: PositionTitle, OrganizationName, PositionLocationDisplay, PositionURI, PositionRemuneration[0] salary, PublicationStartDate; tier 1.5) → `Merge Sources` input 5 (set numberInputs 6). onError+alwaysOutputData.
- **JSearch** (RapidAPI key → `app_settings.jsearch_key`): `JSearch Fetch` (HTTP GET `jsearch.p.rapidapi.com/search?query={{role+loc}}&num_pages=1`, headers `X-RapidAPI-Key` from config + `X-RapidAPI-Host: jsearch.p.rapidapi.com`) → `Normalize JSearch` (data[]: job_title, employer_name, job_city/state/country, job_apply_link, estimated_salary, job_posted_at_datetime_utc; tier 3) → Merge input 6.
- **Apify** (token → `app_settings.apify_token`): use HTTP to `api.apify.com/v2/acts/<actor>/run-sync-get-dataset-items?token=<>` (Greenhouse/Lever/Ashby actor + Google Jobs actor) → `Normalize Apify` (tier 1) → Merge input 7.
- **S2d2 dedup upgrade:** in `Aggregate Jobs`, replace the URL-only dedup with a composite key (canonical apply-URL `[?#]`-stripped + lowercased company+title) and prefer the lower-tier (structured) source on collision. Currently it's URL-only (fine for now).

### S4 — NL → structured filters + F-1 OPT flag  (IN PROGRESS — start here)
Decision reached: **fold into `Expand Query` + `Parse Expand Query`** (cleaner than a parallel node — everything downstream already reads Parse Expand Query). Extend the `Expand Query` prompt + add to `Parse Expand Query`'s `result` object: `salary_min` (int|null), `equity` (bool), `sponsorship_required` (bool), `f1_opt_constraint` (enum), `exclude_recent_layoffs` (bool), `min_funding_stage`, `culture_constraints` ([]), `ambiguity_flags` ([]). These then: (a) feed S3's compensation sub-score (the composite already reads `$('Parse Expand Query').first().json.salary_min`), (b) drive structured-API query params (Adzuna `salary_min`, etc.), (c) the visa sub-score. **F-1 rule:** if `remote` + non-US `country`/region + implies working from outside US → push `ambiguity_flags:"F1_OPT_REMOTE_LOCATION"` + send a non-blocking Telegram clarification ("F-1 OPT remote work must be performed inside the US…"). NOTE current `Parse Expand Query` already has `_parse_error` branches + `_verbose_message` — extend, don't break them. (Current Expand Query/Parse Expand Query were read this session — see git history / the nodes.)

### S5 — free-source company research → /100 + writing bias
Sync full `prompts/CompanyIntel.md` into `CompanyIntel`; add free-source targeting in `Prepare Research` (layoffs.fyi + WARN flcdatacenter.com, TechCrunch/Crunchbase public, Blind/Reddit/IGotAnOffer, levels.fyi/h1bdata, official values pages e.g. aboutamazon.com LPs); the 7-day `Hybrid Cache Search` read-gate already exists. Add `values` + `bullet_selection_biases` to the dossier; `Save Writing Profile` → `company_writing_profiles.guidance`. New `Map Intel To Score` feeds the **company_health** sub-score in `Parse Scorer Output`'s composite (replace the hardcoded `company_health: 60` with a lookup from `company_intel.health_score`, cited). Model `gemini-3.5-flash`.

### S6 — resume/cover render fix + command-center 2-phase port
- **S6a (do first, independent):** `Build Resume LaTeX` → `.replaceAll('{{EMAIL}}', escapeLatexText(email))`; preserve header `$|$` (don't let `normalizeLatexForPdflatex` escape the math separator); flip `Compile Resume PDF`/`Compile Cover PDF` `onError` to an error branch (Send error msg, don't ship blank PDF); tighten `Resume Output Parser` to a strict typed `items` schema; add `Validate Resume Sections` that throws on empty.
- **S6b/c:** port command-center `document-ai/index.ts` 2-phase (PASS1 select tier/JD/value-aware → PASS2 LaTeX fragments) + slot assembly (`SECTION_LATEX`/`%%% SLOT:`/`buildFallbackSlots`) + Pass-3 ATS (`extractATSSignals`/`validateSignals`/`calculateATSScore`); apply S5 `bullet_selection_biases` via the existing `Load Writing Profile` injection. Models claude-haiku-4.5 (gen)/gpt-5.4-mini (ATS). Keep LaTeX service `latex-service:5679`.

### S7 — outreach prompt sync + ToS-compliant hook lane
Sync full `prompts/ContactFinder.md` + `OutreachWriter.md` into the workflow. Add a `Hook Search` lane (GitHub API public activity + conference talks/eng blogs via You.com/Serper/Firecrawl) → `Normalize Hooks` → feed `OutreachWriter` a `hook_sources` field; `Format Outreach` cites the hook. LinkedIn login-scraping + bulk X targeting OUT.

### S8 — Apollo + Hunter contacts (optional BYOK)
Between `Format Contacts` and `OutreachWriter`, gated on `IF: Draft Request?` + provider-enabled: `Apollo Enrich` (`apollo_mixed_people_api_search`/`apollo_people_match`) + `Hunter Verify` → verified contact/title/email; `Log Outreach Cost` → `tool_cost_log`; soft daily budget in `app_settings`. Graceful: missing key → free contact + "unverified" label.

### S9 — model config + polish + cost view + BYOK README
Central model map (`app_settings` `model_<role>` read by an upstream node, or one Set node) so all LLM nodes resolve role→model in one place; ship free defaults, document premium; audit every OpenRouter node to current strings. Telegraph per-job line → `NN/100 · sub-scores — bottleneck`. `costs` sub-command (tool_cost_log by provider/day). **README + .env.example + credentials doc**: which n8n credentials to create (the 6 core + Adzuna/Apify/JSearch/USAJobs/Apollo/Hunter), free-vs-premium provider+model setup, Telegraph token, Ollama bge-m3 pull. Convert the keyed structured providers from `app_settings` to proper n8n credentials.

---

## 7. Critical files & scripts
- **Master workflow (3 copies):** `docker/workflows/CareerForge Master Local v6.3.json` (LIVE), `docker/workflows/CareerForge_Master_local.json`, `workflows/CareerForge_Master_local.json`.
- **Patch scripts (this session):** `scripts/{s1_telegraph_token,s2_serper_gl,s2b_scorer_fix,s2c_firecrawl_fix,s2c2_location_truth,s2d_remoteok,s2d2_adzuna,s3_score100}.js`.
- **Templates to clone:** `scripts/r7_intel_penalty.js`, `r8_values_writing.js`.
- **Gold standard to port (S6):** `../careerforge-command-center/supabase/functions/document-ai/index.ts`.
- **Prompts to sync (S5/S7):** `prompts/{CompanyIntel,ResumeForge_v3,CoverForge_v3,ContactFinder,OutreachWriter}.md`.
- **Schema:** `db/schema.sql` (has `company_intel`, `company_writing_profiles`, `tool_cost_log`, `app_settings`).
- **Full sprint plan also at:** `~/.claude/plans/let-s-actually-get-into-tidy-squid.md` (not in repo).

## 8. How to test (Telegram, ngrok up)
- `find AI jobs in India` → real India jobs (Adzuna) merged with web results, `/100` scores + sub-score breakdown, honest locations, ₹-salary where present, Telegraph "Full list" link.
- `intel <company>` → dossier (after S5: cited + cached).
- `apply N` → resume + cover PDFs (after S6: correct header, real bullets, never blank).
- `find contacts at <co> for <role> in <city>` → contacts; `draft N` → outreach (after S7/S8: cited hook + verified email).
