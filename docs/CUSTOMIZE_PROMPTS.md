# Customize Prompts

CareerForge's personality lives in the LLM nodes of the master workflow. `prompts/*.md` are readable **documentation** of those prompts, regenerated from the live workflow — not an editable source that gets pushed in. Getting this backwards is the #1 way to end up confused about what the bot is actually doing.

## How prompts actually work

```
LLM node in workflows/CareerForge_Master_local.json  →  scripts/export_prompts.js  →  prompts/*.md
              (runtime truth)                                  (extractor)              (read-only docs)
```

The workflow JSON is the runtime source of truth — n8n reads the prompt text straight out of each node. `prompts/*.md` files are generated *from* that JSON so you have something readable to grep/review without opening the n8n UI. Editing a `.md` file directly does nothing — nothing reads it back in.

## Quick edits (for trying something out)

1. Open the workflow in n8n
2. Find the LLM chain node you want to change (e.g., `Pass1 Selection`, `Cover Pass2`, `ForgeScore`)
3. Click it → edit the **Prompt** / system message field
4. Save the workflow

Changes take effect immediately, but only in the n8n UI's copy — they're not committed to the repo, and if you later redeploy from a patch script, they'll be overwritten.

## Permanent edits (the right way)

This repo's convention is patch scripts, not hand-editing the 600KB+ workflow JSON directly:

1. Write a new `scripts/sN_*.js` patch script (top-level, next free sprint number) that anchors on the exact current node text and replaces it — see any file under `scripts/applied/` for the pattern (string-split anchors, a harness that proves the new logic works *before* touching any file). Once deployed and committed, move it to `scripts/applied/` too.
2. Run it inside the n8n container (repo staged under `/tmp`), which rewrites the canonical `workflows/*.json` file.
3. Deploy: `docker cp` the updated JSON in, `n8n import:workflow`, `n8n update:workflow --active=true`, `docker restart`, poll `/healthz`.
4. Re-run `node scripts/export_prompts.js` to refresh `prompts/*.md` so the docs match what you just shipped — then `git diff prompts/` should show exactly your intended change and nothing else. If it shows anything unexpected, something else drifted.

Full recipe and gotchas (WAL-mode SQLite verification, sandbox limits) are in [SETUP.md](../SETUP.md).

## What each prompt controls

| File | Node(s) | What it does |
|------|------|-------------|
| `IntentRouter.md` | Intent Router | Classifies user messages into intents (find_jobs, apply, revise, score, intel, outreach, salary, track, status, setup, prefs, and more) |
| `SeniorityDetector.md` | SeniorityDetector | Detects fresher/junior/mid/senior from resume; also computes JD-fit strategy for the revise guardrail |
| `Pass1_Resume.md` | Pass1 Selection | Selects which resume content to include and how to order sections, adaptive to career tier |
| `Pass2_Resume.md` | Pass2 Generate, Pass2 Regen | Writes tailored, plain-text resume bullets from Pass1's selection |
| `Cover_Pass1.md` | Cover Pass1 | Selects cover letter achievements + company research angle |
| `Cover_Pass2.md` | Cover Pass2 | Writes the cover letter from Cover Pass1's selection |
| `ForgeScore_v3.md` | ForgeScore, ScoreOnly | Scores resume vs job description |
| `ContactFinder.md` | ContactFinder | Extracts contacts from search results |
| `OutreachWriter.md` | OutreachWriter | Writes LinkedIn + email outreach drafts |
| `CompanyIntel.md` | CompanyIntel, CompanyIntel Apply | Analyzes company health, culture, and mission/vision from search results |
| `JobScorer.md` | JobScorer | Ranks jobs from search results — gazetteer-verified location match, company-tier weighting, and H1B-aware work-authorization scoring feed in as deterministic signals alongside the LLM's own judgment |
| `ATS_Extraction.md` | Extract ATS Signals | Extracts ATS-relevant signals from a generated resume for the auto-improve loop |
| `Step0_JD.md` | Step0 JD Analysis | Extracts company/role/requirements from the job description |
| `JDPasteExtract.md` | JD Paste Extract | Extracts company/role from a directly-pasted job description (jd_paste intent) |
| `ExpandQuery.md` | Expand Query | Expands a find_jobs message into structured search parameters (roles, location, seniority) |
| `ReviseForge.md` | ReviseForge | Rewrites the last generated resume/cover letter per a chat-memory revision request |
| `SalarySummarize.md` | SalarySummarize | Synthesizes salary range + negotiation advice from search results |

Run `node scripts/export_prompts.js` any time to regenerate this list against whatever's actually live, in case a node gets renamed or a new LLM node is added.

## Tuning tips

Find the node in n8n (or read its current prompt via `prompts/*.md`), then follow the "Permanent edits" recipe above to ship the change:

- **Make resumes more technical:** In `Pass1 Selection`'s prompt, adjust the JD-keyword-weighting guidance.
- **Change cover letter tone:** In `Cover Pass2`'s prompt, adjust the tone/CTA rules.
- **Adjust scoring thresholds:** In `ForgeScore`'s prompt, change the recommendation thresholds.
- **Add banned phrases:** Each writing prompt (`Pass2_Resume.md`, `Cover_Pass2.md`, `OutreachWriter.md`) has a banned-cliche list — add domain-specific ones you want to avoid.

## Drift warning

`prompts/*.md` can go stale if a node is edited directly in the n8n UI, or via a patch script, without re-running the extractor afterward. Make `node scripts/export_prompts.js && git diff prompts/` a habit after any prompt-touching deploy — a clean diff (or exactly the change you intended) means the docs are trustworthy; anything else means something drifted and needs investigating before you trust what's written here.
