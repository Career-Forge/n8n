# Customize Prompts

CareerForge's personality lives in 11 prompt files under `prompts/`. Each one controls how an LLM node behaves — what it outputs, what rules it follows, and how it writes.

## How prompts work

```
prompts/*.md  →  transform scripts  →  embedded in workflow JSON  →  LLM reads at runtime
   (source)       (build step)          (runtime truth)              (generates output)
```

The prompt `.md` files are the **source of truth for editing**. But the workflow JSON contains the **runtime copy** that n8n actually uses. If you edit a `.md` file, the workflow won't pick it up until you re-run the transform scripts.

## Quick edits (the easy way)

For one-off tweaks, edit the prompt directly in n8n:

1. Open the workflow in n8n
2. Find the LLM chain node you want to change (e.g., "ResumeForge", "CoverForge")
3. Click it → edit the **Prompt** field
4. Save the workflow

Changes take effect immediately. No rebuild needed.

**Downside:** Your edits live only in the workflow JSON. If you re-import the workflow or re-run transforms, they'll be overwritten. For permanent changes, edit the `.md` files instead.

## Permanent edits (the right way)

1. Edit the prompt file in `prompts/` (e.g., `prompts/ResumeForge_v3.md`)
2. Re-run the fix script to re-embed all prompts:
   ```bash
   node scripts/fix_prompts_and_models.js
   ```
3. Re-import the updated `workflows/01_careerforge.json` into n8n

## What each prompt controls

| File | Node | What it does |
|------|------|-------------|
| `IntentRouter.md` | Route Intent | Classifies user messages into 10 intents |
| `SeniorityDetector.md` | SeniorityDetector | Detects fresher/experienced/senior from resume |
| `ForgeScore_v3.md` | ForgeScore, ScoreOnly | Scores resume vs job description (0-10) |
| `ResumeForge_v3.md` | ResumeForge | Generates tailored resume JSON |
| `CoverForge_v3.md` | CoverForge | Generates tailored cover letter JSON |
| `ResumeRefine.md` | ReviseForge (resume mode) | Handles "make it shorter" style edits |
| `CoverRefine.md` | ReviseForge (cover mode) | Handles cover letter revisions |
| `ContactFinder.md` | ContactFinder | Extracts contacts from search results |
| `OutreachWriter.md` | OutreachWriter | Writes LinkedIn + email outreach drafts |
| `CompanyIntel.md` | CompanyIntel | Analyzes company health from search results |
| `JobScorer.md` | JobScorer | Ranks jobs from Greenhouse search |

## Tuning tips

**Make resumes more technical:** In `ResumeForge_v3.md`, find the "Keyword Alignment" section. Add a line like: "Prefer technical keywords over soft-skill keywords when both are applicable."

**Change cover letter tone:** In `CoverForge_v3.md`, find the "No Cliches" section. Add or remove phrases from the banned list. Adjust the "Word Count Target" if you want shorter/longer letters.

**Adjust scoring thresholds:** In `ForgeScore_v3.md`, change the recommendation thresholds. Default: >= 6.0 Apply, >= 4.0 Caution, < 4.0 Skip. Lower the Apply threshold if you want to be less selective.

**Add your own banned phrases:** Each writing prompt has a banned phrases list. Add domain-specific cliches you want to avoid.

## Drift warning

If you edit prompts in the `.md` files but forget to re-run the transform, your workflow will use stale prompts. If you edit prompts in n8n but forget to update the `.md` files, they'll be out of sync.

Pick one source of truth and stick with it. For most users, editing directly in n8n is simplest.
