# CareerForge n8n — Refactor Implementation Plan

> **What this is:** A complete, self-contained execution plan for refactoring the existing CareerForge n8n project into a polished, open-source, job-seeker-focused Telegram bot. Designed to be executed session-by-session by a coding agent (Claude Code, Warp/Oz, or Manus) with minimal back-and-forth.
>
> **How to use:** Each session below has a clear goal, concrete deliverables, technical specifications, and acceptance criteria. Execute them in order. Each session produces a clean git commit.
>
> **For agents:** Read Part 1-3 for context. Execute Part 5 sessions sequentially. Reference Part 6 for implementation details. All decisions in Part 2 are locked — do not re-litigate.

---

## Part 1: Project Context

### What CareerForge is
A multi-interface AI career assistant. The n8n edition is a **single Telegram bot** that handles the full job-seeker workflow:
- Morning job digest (scheduled)
- On-demand tailored resume + cover letter PDFs
- Iterative refinement ("make it shorter", "more metrics")
- Cold outreach contact discovery
- Company health / red-flag intelligence
- Basic application tracking

**Target user:** A single job seeker running this for themselves, self-hosted.

**Cost target:** $0–4/month after a one-time $10 OpenRouter deposit.

### What exists today
- Repo at `github.com/Career-Forge/n8n` (currently at `D:\My-Projects\Career_Forge_Development\careerforge_n8n\`)
- 16 legacy workflow JSONs in `workflows/` (WF01-07 variants, experiments)
- `storage/prompts/` — good-quality base prompts (ResumeForge, CoverForge, ContactForge, ForgeScore, MasterResumeGuide)
- `storage/templates/` — 3 LaTeX skeletons (fresher, experienced, senior) + cover skeleton
- `latex-service/app.py` — working Flask+pdflatex compile service on port 5679
- `chroma-api/` — over-engineered resume-file-server (to be deleted)
- `docker/` — n8n + latex-service compose stack
- `DEPLOYMENT.md` + `README.md` — current versions (to be rewritten)

### What changes (old → new)

| Old | New | Why |
|---|---|---|
| 16 workflow files | 1 workflow file (`01_careerforge.json`) | One bot, multi-intent routing |
| Hardcoded placeholder resume text in nodes | `/data/user-data/master_resume.txt` read via Read Binary File node | User-configurable, no code change |
| chroma-api microservice for resume file | Direct Docker volume mount | Zero extra services |
| Generic HTTP nodes for LLM calls | Native OpenRouter Chat Model sub-nodes + Basic LLM Chain / AI Agent | Cleaner, structured output parsing |
| Regex-based intent detection | LLM router (Llama 3.3 70B `:free`) | Natural language works |
| Text-only resume/cover output | Full PDF via LaTeX + Telegram `sendDocument` | Actual usable deliverables |
| No refinement loop | "revise" intent with chat memory | Iterate without starting over |
| No cold outreach | `outreach` intent with Switch + RRF fan-out | New capability |
| Single search provider | Firecrawl + You.com + Serper fan-out w/ graceful degradation | Better recall, works with any 1-3 providers |

---

## Part 2: Locked Architecture Decisions (do not re-litigate)

1. **One Telegram bot, one workflow file**, 10 intents routed by LLM.
2. **Three LaTeX skeletons** (fresher, experienced, senior) — not one. Research-backed: different seniority needs structurally different layouts.
3. **Master resume via template + AI-fill flow** — user pastes `master_resume_template.txt` into ChatGPT/Claude/Gemini with their old resume, gets a filled version, drops it at `/data/user-data/master_resume.txt`. Zero format learning.
4. **Drop WF07, retire all 01-06 variants.** Archive to `bak/` (gitignored).
5. **OpenRouter is the only mandatory LLM service.** After $10 one-time deposit → 1000 `:free` model calls/day, forever.
6. **Model routing strategy:**
   - **Router / extraction / scoring:** `:free` models (DeepSeek V3, Llama 3.3 70B, Qwen3 Coder)
   - **Writing (resume, cover letter, outreach):** Claude Sonnet 4.6 paid (~$0.05/generation)
7. **PDF delivery via Telegram `sendDocument`** — 50MB limit, plenty for resumes. No Drive/S3/R2 needed.
8. **Apollo.io stays user-side.** Server identifies LinkedIn URLs via Serper/You.com + LLM extraction. User runs Apollo Chrome extension manually to get emails. No server-side Apollo quota burn, no LinkedIn ToS risk.
9. **Search fan-out with Switch node + RRF merge.** User configures 1, 2, or 3 providers; Switch fires configured branches; JS code node does deterministic RRF merge; `:free` LLM does semantic entity resolution after RRF.
10. **Native OpenRouter Chat Model sub-node** (n8n 1.78+) with:
    - **Basic LLM Chain + Structured Output Parser** for stateless tasks (ResumeForge, CoverForge, ForgeScore, extraction)
    - **AI Agent + Postgres Chat Memory + Tools** for conversational tasks (intent router, revise intent)

---

## Part 3: Tech Stack Summary

### Services (all free or near-free)

| Service | Tier | Purpose |
|---|---|---|
| OpenRouter | $10 one-time → 1000 `:free` calls/day | All LLM work |
| Telegram Bot API | Free, unlimited | Chat + PDF delivery |
| Firecrawl | 100K credits via OpenRouter plugin signup | JD + page scraping |
| You.com | $100 free credits = 20K searches w/ LiveCrawl | Primary search for outreach + intel |
| Serper | 2,500 one-time credits | Google SERP fallback |
| Greenhouse Public API | Unlimited, no auth | Direct ATS job discovery |
| Render free + UptimeRobot | 750 hrs/mo + 5-min pings | 24/7 hosting option |

### n8n node types used
- **Trigger nodes:** Telegram Trigger, Schedule Trigger
- **Core:** Switch, Merge, Code, IF, Set, HTTP Request, Respond to Webhook
- **Binary:** Read/Write Files from Disk
- **AI (LangChain-based):**
  - OpenRouter Chat Model (sub-node)
  - Basic LLM Chain
  - AI Agent
  - Structured Output Parser
  - Postgres Chat Memory

### LLM model assignments

| Task | Model | Why |
|---|---|---|
| Intent routing | `meta-llama/llama-3.3-70b-instruct:free` | Fast, reliable, free, good at classification |
| Seniority detection | `deepseek/deepseek-chat-v3:free` | JSON output, free |
| Job scoring (find_jobs) | `google/gemini-3-flash-lite` ($0.25/$1.50/1M) | Quality > free for ranking |
| ForgeScore (apply gate) | `deepseek/deepseek-chat-v3:free` | Free, good JSON |
| ResumeForge | `anthropic/claude-sonnet-4.6` (paid) | Writing quality matters |
| CoverForge | `anthropic/claude-sonnet-4.6` (paid) | Writing quality matters |
| Outreach writer | `anthropic/claude-sonnet-4.6` (paid) | Tone sensitivity |
| Contact extraction (post-RRF) | `deepseek/deepseek-chat-v3:free` | JSON pattern match, free |
| Company intel synthesis | `deepseek/deepseek-chat-v3:free` | JSON from sources, free |

---

## Part 4: Target Repo Structure

```
careerforge-n8n/
│
├── README.md                         # Landing page + mermaid diagram (Session 1)
├── DEPLOYMENT.md                     # 4 hosting tiers (Session 7)
├── API.md                            # External services + cost math (Session 7)
├── LICENSE                           # MIT
├── .gitignore                        # Includes bak/
├── CLAUDE.md                         # (optional) Agent context file
│
├── docs/
│   ├── QUICKSTART.md                 # Docker + ngrok 10-min setup (Session 7)
│   ├── MASTER_RESUME_GUIDE.md        # Template walkthrough (Session 2)
│   ├── CUSTOMIZE_PROMPTS.md          # Tune voice (Session 7)
│   ├── ARCHITECTURE.md               # Deep system diagram (Session 7)
│   └── diagrams/                     # *.mmd sources (Session 7)
│
├── workflows/
│   └── 01_careerforge.json           # THE workflow (Sessions 4-6)
│
├── templates/
│   ├── master_resume_template.txt    # Session 2
│   ├── master_resume_example.txt     # Session 2
│   ├── resume_skeleton_fresher.tex   # (moved from storage/templates/)
│   ├── resume_skeleton_experienced.tex
│   ├── resume_skeleton_senior.tex
│   └── cover_skeleton.tex
│
├── prompts/
│   ├── IntentRouter.md               # Session 3
│   ├── SeniorityDetector.md          # Session 3
│   ├── ResumeForge_v3.md             # Session 3 (upgrade of existing)
│   ├── CoverForge_v3.md              # Session 3 (upgrade of existing)
│   ├── ResumeRefine.md               # Session 3
│   ├── CoverRefine.md                # Session 3
│   ├── ForgeScore_v3.md              # Session 3
│   ├── JobScorer.md                  # Session 3
│   ├── ContactFinder.md              # Session 3 (upgrade of ContactForge)
│   ├── OutreachWriter.md             # Session 3
│   └── CompanyIntel.md               # Session 3
│
├── services/
│   └── latex/
│       ├── Dockerfile
│       ├── app.py                    # (moved from latex-service/)
│       └── requirements.txt
│
├── docker/
│   ├── docker-compose.yml            # n8n + latex + postgres + volumes (Session 7)
│   ├── docker-compose.render.yml     # Render-specific (SQLite + disk)
│   ├── .env.example                  # All API keys documented
│   ├── render.yaml                   # Render Blueprint
│   └── railway.json                  # Railway config
│
├── scripts/
│   ├── setup.sh                      # One-shot local setup
│   ├── uptime_ping.sh                # Keep-alive helper
│   └── test_workflow.sh              # Smoke test webhook
│
└── bak/                              # Gitignored — archived legacy
    ├── workflows/                    # 16 old workflow JSONs
    ├── old_docs/                     # REPORT.md, TODO.md, etc.
    ├── chroma-api/                   # Old ChromaDB service
    └── master_resume/                # Old storage location
```

---

## Part 5: The 8 Sessions

### Session 1 — Repo scaffold + legacy archive + README

**Goal:** Transform the existing repo into the clean target structure. Archive all legacy files. Write commit-ready README.

**Current state (verified):**
- `workflows/` contains 16 JSON files
- `storage/prompts/` contains 5 MD files
- `storage/templates/` contains 4 `.tex` files
- `latex-service/` contains `app.py`, `Dockerfile`, `requirements.txt`
- Top-level: `README.md`, `DEPLOYMENT.md`, `REPORT.md`, `TODO.md`, `report-done.md`, `openrouter_models.json`
- `chroma-api/` exists (to be archived)

**Deliverables:**

1. **Run `scaffold_session1.ps1`** (see Appendix A) which:
   - Creates new folder structure
   - Moves 16 legacy workflows → `bak/workflows/`
   - Moves `REPORT.md`, `TODO.md`, `report-done.md`, `openrouter_models.json` → `bak/old_docs/`
   - Moves `chroma-api/` → `bak/`
   - Moves `latex-service/*` → `services/latex/` (and removes old folder)
   - Moves `storage/templates/*` → `templates/`
   - Moves `storage/prompts/ResumeForge.md` → `prompts/ResumeForge_v3.md`
   - Moves `storage/prompts/CoverForge.md` → `prompts/CoverForge_v3.md`
   - Moves `storage/prompts/ContactForge.md` → `prompts/ContactFinder.md`
   - Moves `storage/prompts/ForgeScore.md` → `prompts/ForgeScore_v3.md`
   - Moves `storage/prompts/MasterResumeGuide.md` → `docs/MASTER_RESUME_GUIDE.md`
   - Moves `storage/master_resume/` → `bak/`
   - Updates `.gitignore` with `bak/`, `user-data/`, `data/user-data/`
   - Creates `LICENSE` (MIT)
   - Creates empty stub files for: `API.md`, `docs/QUICKSTART.md`, `docs/CUSTOMIZE_PROMPTS.md`, `docs/ARCHITECTURE.md`, `docs/diagrams/README.md`, `workflows/README.md`, `templates/master_resume_template.txt`, `templates/master_resume_example.txt`, 7 new prompt stubs

2. **Write `README.md`** (see Appendix B — full commit-ready version with mermaid diagram).

3. **Verify with `git status`** — expect ~50 file moves + ~15 new stubs + modified `.gitignore` + new README + LICENSE.

4. **Commit:** `git commit -am "refactor: Session 1 — repo structure + README + legacy archive"`.

**Acceptance criteria:**
- `workflows/` is empty except for placeholder `README.md`
- `bak/` exists, contains 16+ archived files
- `prompts/` has 11 files (4 renamed + 7 stubs)
- `templates/` has 6 files (4 `.tex` + 2 `.txt` stubs)
- `README.md` renders with working mermaid diagram when viewed in GitHub
- Git log shows a single clean commit

---

### Session 2 — Master Resume Template + Guide

**Goal:** Create the onboarding artifact. User copy-pastes it into ChatGPT/Claude/Gemini with their old resume, gets a filled version, drops at `/data/user-data/master_resume.txt`. Zero format learning.

**Deliverables:**

#### `templates/master_resume_template.txt`

Structure (embed this verbatim):

```
# MASTER RESUME — [YOUR NAME]

> This file is your COMPLETE career data. CareerForge reads it and generates
> tailored resumes + cover letters for each job.
>
> ⚡ FASTEST WAY TO FILL THIS OUT (2 minutes):
> 1. Copy this entire file (Ctrl+A, Ctrl+C)
> 2. Open ChatGPT, Claude, or Gemini
> 3. Paste this in, and also attach or paste your current resume (PDF/DOCX/text)
> 4. Tell the AI: "Fill out this template using my resume. Keep every metric
>    and achievement exactly as written. If you think of anything from my
>    LinkedIn I might have forgotten, add it too. Return the filled template."
> 5. Copy the filled version back into this file
> 6. Save as master_resume.txt in the /data/user-data/ folder
>
> CareerForge will auto-detect your seniority (fresher/experienced/senior)
> from the total years of experience.

## PERSONAL
name: [Your Full Name]
email: [your.email@example.com]
phone: [+1-555-555-5555]
linkedin: [https://linkedin.com/in/yourhandle]
github: [https://github.com/yourhandle]
portfolio: [https://yourname.com or leave empty]
location: [City, State, Country]
work_authorization: [US Citizen | Permanent Resident | H-1B | OPT | requires sponsorship | ...]

## SENIORITY
# Auto-detected from experience count. Override if needed:
# mode: [fresher | experienced | senior]
# fresher = <2 yrs work, student, or recent grad
# experienced = 2-10 yrs
# senior = 10+ yrs or staff/principal/manager titles

## SUMMARY
# 2-3 sentences on who you are professionally. Used primarily in senior mode.
# Leave empty to skip.

## EXPERIENCES
# List reverse-chronologically. One entry per role.
# Use this exact format:

### [Job Title] @ [Company]
dates: [Jan 2022 - Present]
location: [City, State | Remote]
bullets:
  - [Achievement with metric. Start with action verb. Max ~110 chars.]
  - [Technical detail + tool/tech used + quantified impact.]
  - [Leadership or collaboration bullet. Team size. Business outcome.]
  - [Max 4 bullets for most recent role, 3 for 2nd, 2 for older.]

### [Previous Job Title] @ [Previous Company]
dates: [Jul 2020 - Dec 2021]
location: [City, State]
bullets:
  - [...]
  - [...]

## PROJECTS
# Include for fresher + experienced. Optional for senior.
# Include project demos and open source work here.

### [Project Name]
tech: [React, Node, Postgres, etc.]
url: [github.com/... or live demo link]
bullets:
  - [What you built, metrics if available, outcome]
  - [Technical detail or learning]

## EDUCATION
# List reverse-chronologically.

### [Degree] in [Major]
institution: [University Name]
location: [City, State]
graduation: [May 2020]
gpa: [3.8]  # include only if >=3.5 AND you're a fresher
coursework: [relevant course, another course]  # fresher only, optional

## SKILLS
# Grouped. Skip categories you don't need.

### Programming Languages
Python, TypeScript, Go, Rust

### Frameworks & Libraries
React, FastAPI, Next.js, PyTorch, LangChain

### Cloud & DevOps
AWS (EC2, S3, Lambda, RDS), Docker, Kubernetes, Terraform, GitHub Actions

### Databases
PostgreSQL, MongoDB, Redis, Pinecone

### Other
[Additional specialized categories as needed]

## CERTIFICATIONS
# Optional. List with year.
- AWS Solutions Architect Associate (2024)
- Google Cloud Professional Data Engineer (2023)

## ACHIEVEMENTS
# Optional. Speaking, publications, awards, notable open source.
- Speaker at [Conference Name], talk: "[Topic]"
- Published: [Paper/Article Title] (outlet)
- Open source: [Project Name] — X GitHub stars
- [Hackathon wins, awards, etc.]

## LANGUAGES
# Optional. Spoken/written languages.
English (native), Hindi (native), Spanish (professional)
```

#### `templates/master_resume_example.txt`

A filled-out fictional persona — **"Sarah Chen, ML Engineer, 4 yrs experience"**. Write a complete realistic example showing:
- 3 work experiences (most recent at an AI lab, 4 bullets; previous at startup, 3 bullets; internship, 2 bullets)
- 2 projects (one ML-focused, one full-stack)
- 1 education entry (MS in CS, no GPA because 3.3)
- 6 skills categories
- 2 certifications
- 1 achievement (conference talk)

Write bullets that follow production-quality patterns: action verb start, include metrics, include tools used. Example bullet: "Built retrieval pipeline serving 2M queries/day with <50ms p99 latency using FAISS and PyTorch."

#### `docs/MASTER_RESUME_GUIDE.md`

Expand the existing file (moved from `storage/prompts/MasterResumeGuide.md`) into a full walkthrough:
- What this file is and why it matters
- Step-by-step: how to get from "current resume" to "filled template" using ChatGPT/Claude/Gemini (include exact prompts)
- How to verify the filled version (spot-check 3 bullets for metric preservation)
- Where to put the final file (`/data/user-data/master_resume.txt`)
- What happens if fields are missing (CareerForge omits them, doesn't hallucinate)
- Troubleshooting: common issues (metric loss, role-swap errors, hallucinated companies)

**Acceptance criteria:**
- Template can be copy-pasted into any major LLM and produces a valid filled version
- Example persona reads naturally and demonstrates all supported fields
- Guide is under 1000 words, ends with clear "next step" pointer

**Commit:** `"feat(templates): master_resume_template + guide + example persona"`

---

### Session 3 — MEGA Prompts (11 files)

**Goal:** Port the existing 4 prompts to v3 quality and write the 7 new ones. Each prompt is a Markdown file that becomes the `system` message of a Basic LLM Chain or AI Agent node in the workflow.

**Reference materials to study first:**
- `prompts/ResumeForge_v3.md` (existing, moved from `storage/prompts/ResumeForge.md`) — has solid base rules: TA/RA metric guardrails, 6-entry rule, 110-char limit, entry budget by seniority, banned-commands list
- `prompts/CoverForge_v3.md` (existing) — has 3-bullet hybrid structure, no-coffee rule, distance-aware CTA
- `prompts/ForgeScore_v3.md` (existing) — has 100-point rubric
- Production Web app patterns in `D:\My-Projects\Career_Forge_Development\Career_Forge_Web\server\resumeforge.ts` — shows `escapeLatexText`, `sanitizeResumeContentBlock`, `wrapResumeWithSkeleton` functions and CONTENT_START/CONTENT_END marker pattern

**CRITICAL output contract for all prompts:** Must return **strict JSON** matching the schema below. The Structured Output Parser in n8n enforces this.

**Deliverables (11 prompt files):**

#### 3.1 `prompts/IntentRouter.md`

**Role:** AI Agent system prompt. Classifies Telegram message → intent + extracted entities.

**Input:** User's raw message text + Postgres Chat Memory (last 5 turns).

**Output JSON schema:**
```json
{
  "intent": "help | find_jobs | apply | revise | score | intel | outreach | salary | track | status",
  "entities": {
    "company": "string or null",
    "role": "string or null",
    "location": "string or null",
    "job_number": "integer or null",
    "changes": "string or null (for revise intent)"
  },
  "confidence": "high | medium | low",
  "reasoning": "1 sentence on why this intent"
}
```

**Key rules:**
- Numeric-only messages ("3") → `apply`, `job_number: 3`
- Messages with refinement language ("shorter", "more X", "change Y") → `revise`
- Questions about company safety/layoffs → `intel`
- "who should I contact at X" or "find recruiters at X" → `outreach`
- Default to `help` if unclear, low confidence

#### 3.2 `prompts/SeniorityDetector.md`

**Role:** Basic LLM Chain. Reads master_resume.txt, outputs seniority mode.

**Output JSON schema:**
```json
{
  "mode": "fresher | experienced | senior",
  "total_years_experience": 4,
  "reasoning": "1 sentence: why this mode"
}
```

**Rules:**
- `fresher`: <2 years professional experience OR current student OR graduated <12 months ago
- `experienced`: 2-10 years
- `senior`: 10+ years OR current title includes "staff", "principal", "director", "VP", "manager"

#### 3.3 `prompts/ResumeForge_v3.md` (UPGRADE existing)

**Role:** Basic LLM Chain + Structured Output Parser. Generates tailored resume CONTENT in structured JSON, NOT raw LaTeX. A downstream JS node converts JSON → LaTeX using the skeleton.

**This is a significant change from the existing prompt.** The existing prompt outputs raw LaTeX directly — that's brittle. New approach: LLM returns structured JSON with semantic meaning, JS node deterministically fills the LaTeX skeleton.

**Input:**
- Master resume (full text, from `/data/user-data/master_resume.txt`)
- Job description
- Seniority mode (fresher/experienced/senior)
- Job details (title, company)

**Output JSON schema:**
```json
{
  "sections": [
    {
      "heading": "Experience",
      "items": [
        {
          "type": "role",
          "role": "Senior ML Engineer",
          "company": "Anthropic",
          "location": "San Francisco, CA",
          "dates": "Jun 2023 - Present",
          "bullets": [
            {
              "keyword": "Retrieval Infrastructure",
              "text": "Built FAISS-based retrieval pipeline serving 2M queries/day with <50ms p99 latency using PyTorch and Ray"
            },
            { "...": "..." }
          ]
        }
      ]
    },
    {
      "heading": "Projects",
      "items": [
        {
          "type": "project",
          "name": "OpenRAG",
          "tech": "Python, LangChain, Pinecone",
          "url": "github.com/sarah/openrag",
          "bullets": [ { "keyword": "...", "text": "..." } ]
        }
      ]
    },
    {
      "heading": "Skills",
      "items": [
        {
          "type": "skill_line",
          "category": "Programming Languages",
          "skills": "Python, TypeScript, Go, Rust"
        }
      ]
    },
    {
      "heading": "Education",
      "items": [
        {
          "type": "education",
          "degree": "M.S.",
          "major": "Computer Science",
          "institution": "Stanford University",
          "location": "Stanford, CA",
          "dates": "2020 - 2022",
          "gpa": null,
          "coursework": null
        }
      ]
    }
  ]
}
```

**Core rules (port from existing prompt, enhance):**

1. **NO HALLUCINATIONS** — every bullet text must be directly traceable to the master resume. Rephrase for keyword alignment but preserve every metric.
2. **110-character bullet limit** — `text` field max 110 chars (excluding `\textbf{keyword}` prefix, which is rendered as "**Keyword:**" in LaTeX).
3. **Entry budget by seniority:**
   - Fresher: 2-3 experiences + 2-3 projects (max 6 total)
   - Experienced: 2-4 experiences + 1-3 projects (max 6 total)
   - Senior: 3-5 experiences + 0-1 projects (max 6 total)
4. **Bullet count by role position:**
   - Most recent role: max 4 bullets
   - 2nd most recent: max 3 bullets
   - Older roles: max 2 bullets
   - Projects: max 2 bullets each
5. **TA/RA guardrails:** If a bullet mentions "Teaching Assistant" role, NEVER fabricate percentage metrics (use scope/volume: "120 students", "3 sessions/week"). For Research Assistant, real research outcomes are OK if in master resume.
6. **Skills categories:** 4-6 categories max. Reorder by JD relevance (most relevant tech first).
7. **Education rules by mode:**
   - Fresher: include graduation date + GPA (if ≥3.5) + relevant coursework
   - Experienced: `Degree | Major | Institution`, NO date, NO GPA
   - Senior: just `Degree | Institution`, minimize
8. **Keyword alignment:** Each bullet's `keyword` field should reflect a skill/competency from the JD.

**Error handling:** If master resume is missing critical fields or is <200 chars, return:
```json
{ "error": "Master resume incomplete", "missing": ["experiences", "..."] }
```

#### 3.4 `prompts/CoverForge_v3.md` (UPGRADE existing)

**Role:** Basic LLM Chain + Structured Output Parser. Generates cover letter as structured JSON.

**Output JSON schema:**
```json
{
  "title": "Software Engineer — Anthropic",
  "salutation": "Dear Anthropic Hiring Team,",
  "hook": "Two sentences opening that references the company's recent work or a specific team focus.",
  "bullets": [
    {
      "keyword": "Retrieval Infrastructure",
      "text": "At [PreviousCo], I built a FAISS-based retrieval pipeline serving 2M queries/day — the exact kind of inference-latency challenge your team mentioned in the job description."
    },
    { "keyword": "...", "text": "..." },
    { "keyword": "...", "text": "..." }
  ],
  "cta": "I'd love to discuss how my background fits. Coffee in SF this week, or a 30-min video call?",
  "word_count": 387
}
```

**Core rules (port + enhance):**
1. **Word count target: 350-450 words** (sum of hook + 3 bullets + cta, roughly)
2. **3 bullets always** — each references a specific JD requirement + master resume evidence
3. **Distance-aware CTA:** If candidate location matches company HQ city → offer coffee. Otherwise → 30-min video.
4. **No "passionate about" / "excited to apply" clichés.** Lead with specific evidence.
5. **No hallucinated company details.** If company research isn't provided, keep it candidate-focused.

#### 3.5 `prompts/ResumeRefine.md`

**Role:** AI Agent system prompt. Takes previous resume JSON + user's change request → returns updated JSON in same schema.

**Input:** Previous full JSON from ResumeForge + user's natural-language change request (e.g., "make it shorter", "emphasize Python more", "add RAG").

**Output:** Updated JSON (same schema as ResumeForge_v3) + a `changes_summary` field:
```json
{
  "sections": [ /* same schema */ ],
  "changes_summary": "Shortened bullets to 95 chars avg (was 108). Moved Python skill to front. Added RAG keyword to 2 bullets."
}
```

**Rules:**
- Preserve the overall structure unless user asks to reorder
- Honor "shorter" by reducing bullet length, not by cutting entries (unless user says "cut X")
- If user says "add X", find the most relevant existing bullet and enhance; DON'T fabricate a new experience

#### 3.6 `prompts/CoverRefine.md`

Same pattern as 3.5 but for cover letter JSON.

#### 3.7 `prompts/ForgeScore_v3.md` (UPGRADE existing)

**Role:** Basic LLM Chain + Structured Output Parser. Scores resume vs JD.

**Output schema:**
```json
{
  "overall_score": 7.5,
  "dimensions": {
    "skills_match": 8,
    "experience_relevance": 7,
    "metric_impact": 9,
    "seniority_fit": 6,
    "keyword_coverage": 8,
    "leadership_signals": 5
  },
  "gaps": [
    "No direct mention of Kubernetes deployment experience",
    "Missing leadership metrics for the Senior title"
  ],
  "strengths": [
    "Strong retrieval infrastructure signal",
    "Multiple quantified achievements"
  ],
  "recommendation": "Apply | Caution | Skip"
}
```

**Rules:**
- `overall_score` is 0-10 (one decimal)
- Gate threshold: `overall_score < 6` → recommend Skip (downstream workflow asks user if they want to continue anyway)

#### 3.8 `prompts/JobScorer.md`

**Role:** Lightweight scorer for the find_jobs flow. Ranks jobs in a batch.

**Input:** Master resume summary + batch of 20 jobs
**Output:**
```json
{
  "scored": [
    { "job_id": "...", "fit_score": 8, "one_liner": "Strong fit — retrieval infra match" }
  ]
}
```

**Rules:** Simpler than ForgeScore. Just a 0-10 ranking with a one-line reason per job.

#### 3.9 `prompts/ContactFinder.md` (UPGRADE existing `ContactForge.md`)

**Role:** Extracts named contacts from aggregated search results (AFTER RRF merge).

**Input:** Top 15 deduped search results (title + snippet + URL per result) + company + target roles + candidate location.

**Output:**
```json
{
  "contacts": [
    {
      "name": "Sarah Chen",
      "role": "University Recruiter, ML",
      "type": "Recruiter | Hiring Manager | IC | Director | VP",
      "linkedin_url": "https://linkedin.com/in/sarahchen",
      "location": "SF",
      "priority": "High | Medium | Low",
      "confidence": "High | Medium | Low",
      "reason": "Actively posting about ML hiring last week",
      "sources": ["firecrawl", "youcom"]
    }
  ],
  "top_priority": [
    { "name": "Sarah Chen", "reason": "Closest-fit recruiter + recent hiring activity" }
  ],
  "search_tips": [
    "Try adding 'NYC' to your search if most results are SF-only"
  ]
}
```

**Rules:**
- ONLY include contacts whose NAMES appear in the provided search results
- Never invent LinkedIn URLs — if one isn't in the results, set to null
- Priority: Recruiters + Hiring Managers = High; ICs on target team = Medium; Directors/VPs = Low (hard to reach cold)
- Return empty `contacts: []` if no named people in sources

#### 3.10 `prompts/OutreachWriter.md`

**Role:** Generates 4-variant outreach for a selected contact.

**Input:** Contact name + role + type + company + candidate's target role + candidate location + contact location.

**Output:**
```json
{
  "subject": "Retrieval Infrastructure role at Anthropic",
  "linkedin_message": "Hi Sarah — saw your recent post about ML hiring. I've spent the last 2 years building FAISS retrieval at scale (2M QPS, sub-50ms p99). Would love to connect re: your openings.",
  "email_body": "Hi Sarah,\n\n[specific hook from their recent work]\n\n[one sentence on fit]\n\n[one metric-heavy bullet from resume]\n\n[location-aware CTA]\n\nBest,\n[Name]",
  "followup_message": "Hi Sarah — following up on my note last week about the ML roles. Totally get if timing's off, happy to check back later or connect directly on LinkedIn for future openings."
}
```

**Rules:**
- **LinkedIn message under 300 chars** (LinkedIn connection note limit)
- **Email 100-150 words**
- **Location-aware CTA:** same city → "coffee this week"; same country, different city → "30-min video"; different country → "30-min video, flexible on time zones"
- **Never flatter.** Lead with a specific reference (recent post, their company's open source, etc.)

#### 3.11 `prompts/CompanyIntel.md`

**Role:** Generates company health report from aggregated search results.

**Input:** Company name + search results covering news, reviews, layoffs, funding, H1B, culture.

**Output schema:**
```json
{
  "company": "Anthropic",
  "health_score": 85,
  "recommendation": "Apply | Caution | Avoid",
  "summary": "2-3 sentence overview",
  "layoffs": {
    "has_recent_layoffs": false,
    "details": "No layoffs in past 12 months",
    "timeline": []
  },
  "sentiment": {
    "glassdoor_rating": 4.3,
    "overall_mood": "Positive",
    "positives": ["Strong engineering culture", "..."],
    "negatives": ["High bar can feel stressful", "..."],
    "breakdown": {
      "work_life_balance": 4.0,
      "compensation": 4.6,
      "career_growth": 4.2,
      "management": 4.1
    }
  },
  "h1b": {
    "sponsors": true,
    "recent_approvals": "~30 approvals in 2024",
    "trend": "Increasing | Stable | Decreasing | Unknown"
  },
  "funding": {
    "stage": "Series E",
    "last_round": "$2B at $18.4B valuation",
    "runway": "Strong"
  },
  "culture": {
    "type": "Research-first, mission-driven",
    "values": ["Safety", "Empirical research", "Collaboration"]
  },
  "red_flags": [],
  "green_flags": ["Active open source", "Clear promotion criteria", "..."]
}
```

**Rules:**
- Use ONLY provided sources. No invented facts.
- `health_score`: 0-100 composite (70+ = safe, 40-70 = caution, <40 = avoid)
- `h1b.sponsors`: true/false from sources (if no info: false)
- For private companies without Glassdoor data, set `glassdoor_rating: null`

**Acceptance criteria:**
- All 11 files exist in `prompts/`
- Each file has a clear `# Role`, `# Input`, `# Output` schema, `# Rules` structure
- v3 prompts preserve all battle-tested rules from the existing base prompts (TA/RA guardrails, 110-char limit, 3-bullet cover structure)
- Prompts can be loaded via `{{ $readBinary("prompts/ResumeForge_v3.md") }}` pattern in n8n

**Commit:** `"feat(prompts): full v3 prompt library (11 files)"`

---

### Session 4 — Workflow Part 1: Intent Router + find_jobs + help

**Goal:** Build the first half of `01_careerforge.json` — Telegram trigger, LLM intent router, and two branches (help, find_jobs). End-to-end testable: user texts the bot, gets a help message or a job digest.

**Deliverable:** `workflows/01_careerforge.json` (first iteration, ~25 nodes).

#### Architecture

```
Telegram Trigger
     │
     ▼
Set node: Extract chatId + message text
     │
     ▼
AI Agent: Intent Router
├── OpenRouter Chat Model (meta-llama/llama-3.3-70b-instruct:free)
├── Postgres Chat Memory (session: chatId)
└── Structured Output Parser (schema from prompts/IntentRouter.md)
     │
     ▼
Switch node: route by $json.intent
├── help            → Help branch (static text response)
├── find_jobs       → find_jobs branch (see below)
├── apply           → (stub — Session 5)
├── revise          → (stub — Session 6)
├── score           → (stub — Session 6)
├── intel           → (stub — Session 6)
├── outreach        → (stub — Session 6)
├── salary          → (stub — Session 6)
├── track           → (stub — Session 6)
├── status          → (stub — Session 6)
└── fallback        → "Sorry, didn't understand. Try /help."
```

Scheduled triggers (parallel):
- **8am ET weekdays:** cron `0 12 * * 1-5` (UTC, 8am EDT — adjust to `0 13 * * 1-5` during EST)
- **11:30am ET weekdays:** cron `30 15 * * 1-5` UTC
- Both merge into the find_jobs branch with a synthetic intent payload.

#### find_jobs branch

```
Entry: { intent: "find_jobs", entities: { role?, location? } }
     │
     ▼
Set node: Build Greenhouse query URLs (top 50 companies — hardcoded list in a Set node)
     │
     ▼
HTTP Request (split in batches): GET https://boards-api.greenhouse.io/v1/boards/{company}/jobs
     │
     ▼
Code node: Filter by role keywords + location
     │
     ▼
Merge node: Combine all companies' results
     │
     ▼
Code node: Dedupe, take top 20 by recency
     │
     ▼
Read Binary File: /data/user-data/master_resume.txt → convert to string
     │
     ▼
Basic LLM Chain: JobScorer
├── OpenRouter Chat Model (google/gemini-3-flash-lite)
├── Structured Output Parser (JobScorer schema)
└── Input: master_resume_summary + batch of 20 jobs
     │
     ▼
Code node: Sort by fit_score desc, take top 5
     │
     ▼
Code node: Format as Telegram message with numbered list
     │
     ▼
Telegram: sendMessage to chatId
     │
     ▼
Postgres Chat Memory: Store jobs with IDs 1-5 (for later /apply N reference)
```

#### Implementation notes

- **OpenRouter credential setup** — create an n8n credential of type "Header Auth" with name "OpenRouter API", header `Authorization: Bearer YOUR_KEY`.
- **Postgres Chat Memory** — if using SQLite mode (Render free tier), swap this for Window Buffer Memory in-memory (lose persistence across restarts, trade-off for zero-Postgres).
- **Greenhouse company list** — start with a hardcoded Set node containing top 50 AI/ML companies. Format: `["anthropic", "openai", "scale", "databricks", "huggingface", ...]`. Users can edit this in the workflow.
- **HTTP Request retry:** 3 retries, 5s delay, Timeout 15s per Greenhouse call.
- **Error handling:** Wrap each HTTP call; failures log + skip rather than halt the batch.

#### Testing

Manual test cases:
1. Text "help" → expect help text with command list
2. Text "hi" or "what can you do" → LLM routes to help
3. Text "find AI jobs" → expect digest with top 5 jobs
4. 8am EDT on a weekday → scheduled trigger fires digest to hardcoded chat_id
5. Text "sdf asdf" → fallback path, "didn't understand"

**Acceptance criteria:**
- Workflow JSON is well-formatted, no dangling connections
- All nodes have descriptive names (cf-<number> prefix consistent with existing convention)
- Credentials use placeholder IDs (replace on import — don't hardcode secrets)
- Test a `find_jobs` run end-to-end in a local n8n instance

**Commit:** `"feat(wf): Session 4 — intent router + help + find_jobs"`

---

### Session 5 — Workflow Part 2: Apply pipeline (full PDF flow)

**Goal:** Build the apply branch. User replies with a job number (1-5), bot generates tailored resume.pdf + cover.pdf and sends both via Telegram `sendDocument`.

**Deliverable:** `workflows/01_careerforge.json` updated with the apply branch (~20 more nodes).

#### Architecture (apply branch)

```
Entry: { intent: "apply", entities: { job_number: 3 } }
     │
     ▼
Telegram sendMessage: "⚙️ Generating your package... ~45 sec"
     │
     ▼
Postgres Chat Memory: Retrieve job #3 from the last find_jobs batch
     │
     ▼
Read Binary File: /data/user-data/master_resume.txt
     │
     ▼
Basic LLM Chain: SeniorityDetector
├── OpenRouter Chat Model (deepseek/deepseek-chat-v3:free)
└── Structured Output Parser (SeniorityDetector schema)
     │
     ▼
Set node: Load the right skeleton file based on seniority
   - fresher → templates/resume_skeleton_fresher.tex
   - experienced → templates/resume_skeleton_experienced.tex
   - senior → templates/resume_skeleton_senior.tex
     │
     ▼
Read Binary File: loaded skeleton path
     │
     ▼
Basic LLM Chain: ForgeScore_v3
├── OpenRouter Chat Model (deepseek/deepseek-chat-v3:free)
└── Structured Output Parser (ForgeScore schema)
     │
     ▼
IF: overall_score < 6
├── TRUE  → Telegram: "⚠️ Low fit (4/10). Gaps: X, Y. Skip or continue?"
│           → wait for reply (abort or continue)
└── FALSE → continue
     │
     ▼
SPLIT INTO PARALLEL BRANCHES (n8n Merge node in "wait for all" mode downstream):

BRANCH A — Resume:
     │
     ▼
Basic LLM Chain: ResumeForge_v3
├── OpenRouter Chat Model (anthropic/claude-sonnet-4.6)
└── Structured Output Parser (ResumeForge schema)
     │
     ▼
Code node: Build resume LaTeX
  - For each section → render items as LaTeX macros
  - Call escapeLatexText on every string field
  - Call sanitizeResumeContentBlock on final content block
  - Call wrapResumeWithSkeleton(skeleton, header, contentBlock)
  - Output: full .tex string
     │
     ▼
HTTP Request: POST http://latex-service:5679/compile
  - Body: raw LaTeX string
  - Response: PDF binary (application/pdf)
  - Retry: 3x, 5s delay, Timeout: 300s
     │
     ▼
Telegram: sendDocument
  - File: the PDF binary
  - Filename: "{company}_{role}_resume_{YYYYMMDD}.pdf"
  - Caption: "✅ Resume (ForgeScore: {score}/10)"

BRANCH B — Cover Letter:
     │  (same pattern as A)
     ▼
Basic LLM Chain: CoverForge_v3 → OpenRouter Sonnet 4.6 → Structured Output Parser
     │
     ▼
Code node: Build cover LaTeX from cover_skeleton.tex
     │
     ▼
HTTP Request: POST latex-service:5679/compile (same config)
     │
     ▼
Telegram: sendDocument with cover_{company}_{role}.pdf

BRANCHES MERGE:
     │
     ▼
Postgres Chat Memory: Store context for revise flow
  { last_apply: { job_id, resume_json, cover_json, skeleton, timestamp } }
     │
     ▼
Telegram: "✅ Done! Reply with changes ('shorter', 'more Python') or 'track' to save."
```

#### Key JavaScript functions to implement in Code nodes

Port these exactly from `Career_Forge_Web/server/resumeforge.ts` and `latex.ts`:

**`escapeLatexText(input)`:** (JS, inline in Code node)
```javascript
function escapeLatexText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}
```

**`sanitizeResumeContentBlock(content)`:** Strips banned LaTeX commands from LLM output as a safety net. Full version lives in `Career_Forge_Web/server/resumeforge.ts`. Port verbatim.

**`wrapResumeWithSkeleton({skeleton, headerLatex, contentLatex})`:** Marker-based injection between `%%% HEADER_START/END` and `%%% CONTENT_START/END`. Port verbatim from the Web app.

**`normalizeLatexForPdflatex(input)`:** Strips smart quotes, em-dashes, ₹/€/£ currency symbols, non-ASCII chars. Port verbatim. Called by the latex-service before compilation (already in `services/latex/app.py`, verify + enhance if needed).

#### Telegram `sendDocument` node config

n8n Telegram node:
- Operation: Send Document
- Chat ID: `{{ $('Entry').first().json.chat_id }}`
- Binary Data: true
- Binary Property: `data` (the name the HTTP Request node saves the PDF response under)
- File Name: `={{ $json.company }}_{{ $json.role }}_resume_{{ $now.format('yyyyMMdd') }}.pdf`
- Parse Mode: HTML (for caption formatting)

#### Testing

1. Reply "3" in Telegram after a find_jobs response → expect 2 PDFs delivered in ~45 sec
2. Apply to a job where ForgeScore < 6 → expect the caution prompt
3. Verify PDFs open cleanly, no LaTeX errors, single page each
4. Check that filename includes company + role slugified (no spaces)

**Acceptance criteria:**
- End-to-end apply flow works from Telegram in <60 seconds
- PDFs are valid, openable, properly formatted
- Chat memory stores context correctly for revise flow
- Error paths (low score, LaTeX failure, LLM failure) produce friendly Telegram messages, not stack traces

**Commit:** `"feat(wf): Session 5 — apply branch with full PDF pipeline"`

---

### Session 6 — Workflow Part 3: Revise + Outreach + Intel + Score/Salary/Track/Status

**Goal:** Build the remaining 7 intent branches. Centerpiece: the Switch-fan-out-RRF pattern for outreach and intel.

**Deliverable:** `workflows/01_careerforge.json` finalized (~30 more nodes).

#### Revise branch (uses chat memory)

```
Entry: { intent: "revise", entities: { changes: "make it shorter" } }
     │
     ▼
Postgres Chat Memory: Retrieve last_apply context
     │
     ▼
IF: last_apply exists?
├── FALSE → Telegram: "Nothing to revise. Run /apply first."
└── TRUE  → continue
     │
     ▼
AI Agent: ResumeRefine OR CoverRefine (detect from user's message — if mentions "cover letter" → CoverRefine, else ResumeRefine by default)
├── OpenRouter Chat Model (Sonnet 4.6)
├── Postgres Chat Memory (same session)
└── Structured Output Parser
     │
     ▼
(same LaTeX build + compile + sendDocument flow as apply branch)
     │
     ▼
Postgres Chat Memory: Overwrite last_apply with updated context
     │
     ▼
Telegram: "✏️ Updated! Changes: {changes_summary}. More tweaks?"
```

#### Outreach branch (Switch + fan-out + RRF)

```
Entry: { intent: "outreach", entities: { company, role, location? } }
     │
     ▼
Code node: Build 3 search query variants:
  - "{company} {role} recruiter hiring manager LinkedIn"
  - "{company} {role} engineer team lead site:linkedin.com/in"
  - "{company} {role} {location?} hiring team"
     │
     ▼
Switch node: Detect configured search providers
  Mode: Rules
  Send to all matching outputs: ON
  Fallback Output: Extra Output
  Rules:
    - Rule 1: {{ $env.FIRECRAWL_API_KEY }} is not empty → Output 0
    - Rule 2: {{ $env.YOUCOM_API_KEY }}    is not empty → Output 1
    - Rule 3: {{ $env.SERPER_API_KEY }}    is not empty → Output 2
  Fallback:                                              → Output 3
     │
     ▼
Branch 0: Firecrawl parallel searches (3 queries, POST /search, full markdown)
Branch 1: You.com parallel searches (3 queries, GET /search?livecrawl=true)
Branch 2: Serper parallel searches (3 queries, POST search with q=...)
Branch 3 (fallback): Telegram "⚠️ Configure FIRECRAWL_API_KEY, YOUCOM_API_KEY, or SERPER_API_KEY to use /outreach. See docs/QUICKSTART.md."
     │
     ▼
Merge node (combine mode): Wait for all active branches, concat result arrays
     │
     ▼
Code node: RRF merge + URL dedup (see Part 6.2 for full JS)
     │
     ▼
Basic LLM Chain: ContactFinder
├── OpenRouter Chat Model (deepseek/deepseek-chat-v3:free)
└── Structured Output Parser (ContactFinder schema)
     │
     ▼
Code node: Format top 5 contacts as Telegram Markdown
     │
     ▼
Telegram: sendMessage with contact list + "Reply 'draft 1' for outreach templates"
     │
     ▼
Postgres Chat Memory: Store contacts list (for later 'draft N' reference)
```

#### "draft N" sub-intent (within outreach)

When the router sees messages like "draft 1":
```
Retrieve contact #N from memory
     │
     ▼
Basic LLM Chain: OutreachWriter
├── OpenRouter Chat Model (Sonnet 4.6)
└── Structured Output Parser (OutreachWriter schema)
     │
     ▼
Telegram sendMessage: 4 sections (subject, LinkedIn, email, followup)
  Each as a code block so user can easily copy-paste
```

#### Intel branch

```
Entry: { intent: "intel", entities: { company } }
     │
     ▼
Same Switch pattern as outreach, but with different queries:
  - "{company} latest news"
  - "{company} layoffs 2024 2025 2026"
  - "{company} glassdoor reviews"
  - "{company} H1B sponsorship"
  - "{company} funding round"
  - "{company} company culture"
     │
     ▼
Same RRF merge + CompanyIntel LLM synthesis
     │
     ▼
Telegram: Format as nicely-structured message with sections + emoji indicators
```

#### Simple branches (score, salary, track, status)

- **score**: Same as apply's ForgeScore step but without generating PDFs — just return the score message
- **salary**: You.com search for "salary {role} at {company}" → LLM summarizes → Telegram
- **track**: Update last_apply context with `status: "applied"` + Telegram ack
- **status**: List all tracked applications from chat memory

#### Testing

1. Reply "make bullets shorter" after apply → expect revised resume PDF
2. Send "/outreach Anthropic ML" → expect 5 contacts with LinkedIn URLs
3. Send "draft 1" → expect 4 outreach variants in clean markdown
4. Send "intel about Databricks" → expect health report
5. Unset FIRECRAWL_API_KEY, run /outreach → expect fallback message with config tip
6. Set only SERPER_API_KEY, run /outreach → expect works with just Serper

**Acceptance criteria:**
- All 10 intents route correctly
- Switch fan-out gracefully degrades to 1 or 2 providers
- RRF merge produces deduped + ranked output
- All LLM calls use the correct model (free vs paid) per the tier table

**Commit:** `"feat(wf): Session 6 — revise + outreach + intel + support intents"`

---

### Session 7 — Deployment configs + API.md + Architecture docs

**Goal:** Ship deployment-ready configs for 4 hosting tiers. Write the full API.md and architecture diagrams.

**Deliverables:**

#### `docker/docker-compose.yml` (primary)

```yaml
version: '3.8'

services:
  n8n:
    image: n8nio/n8n:latest
    ports:
      - "5678:5678"
    environment:
      - GENERIC_TIMEZONE=America/New_York
      - TZ=America/New_York
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=${N8N_USER:-careerforge}
      - N8N_BASIC_AUTH_PASSWORD=${N8N_PASSWORD:-demo1234}
      - WEBHOOK_URL=${WEBHOOK_URL:-http://localhost:5678/}
      - DB_TYPE=sqlite  # or postgresdb for production
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
    volumes:
      - n8n_data:/home/node/.n8n
      - ../templates:/data/templates:ro
      - ../prompts:/data/prompts:ro
      - ../user-data:/data/user-data:ro
    depends_on:
      - latex
    restart: unless-stopped

  latex:
    build:
      context: ../services/latex
    ports:
      - "5679:5679"
    restart: unless-stopped

volumes:
  n8n_data:
```

#### `docker/.env.example`

```env
# ═══════════════════════════════════════════════════════════
# CareerForge n8n — Environment Variables
# Copy to .env and fill in your values
# ═══════════════════════════════════════════════════════════

# --- n8n auth ---
N8N_USER=careerforge
N8N_PASSWORD=pick_a_password_here
N8N_ENCRYPTION_KEY=run_openssl_rand_hex_32_to_generate_this

# --- Public URL (for webhooks) ---
# Local dev with ngrok: https://abc123.ngrok-free.app
# Production: https://your-domain.com
WEBHOOK_URL=https://abc123.ngrok-free.app

# --- REQUIRED: OpenRouter (do $10 deposit for 1000/day free tier) ---
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxxx

# --- REQUIRED: Telegram Bot ---
# Get via @BotFather on Telegram
TELEGRAM_BOT_TOKEN=123456789:xxxxxxxxxx

# --- REQUIRED: at least ONE search provider ---
FIRECRAWL_API_KEY=fc-xxxxxxxxxx   # Get via OpenRouter plugin signup (100K free)
YOUCOM_API_KEY=                    # Optional. Sign up at api.you.com ($100 free)
SERPER_API_KEY=                    # Optional. Sign up at serper.dev (2500 free)

# --- Model overrides (optional, defaults in the workflow) ---
# RESUMEFORGE_MODEL=anthropic/claude-sonnet-4.6
# COVERFORGE_MODEL=anthropic/claude-sonnet-4.6
# INTENT_ROUTER_MODEL=meta-llama/llama-3.3-70b-instruct:free
# FORGESCORE_MODEL=deepseek/deepseek-chat-v3:free
```

#### `docker/render.yaml` (Render Blueprint)

```yaml
services:
  - type: web
    name: careerforge-n8n
    env: docker
    dockerfilePath: ./Dockerfile
    plan: free
    disk:
      name: n8n-data
      mountPath: /home/node/.n8n
      sizeGB: 1
    envVars:
      - key: GENERIC_TIMEZONE
        value: America/New_York
      - key: DB_TYPE
        value: sqlite
      - key: WEBHOOK_URL
        generateValue: true  # Render sets this to the service's .onrender.com URL
      - key: N8N_BASIC_AUTH_ACTIVE
        value: "true"
      - key: N8N_ENCRYPTION_KEY
        generateValue: true
      - key: OPENROUTER_API_KEY
        sync: false  # manually set in Render dashboard
      - key: TELEGRAM_BOT_TOKEN
        sync: false
      - key: FIRECRAWL_API_KEY
        sync: false
      - key: YOUCOM_API_KEY
        sync: false
      - key: SERPER_API_KEY
        sync: false

  - type: web
    name: careerforge-latex
    env: docker
    dockerfilePath: ./services/latex/Dockerfile
    plan: free
    healthCheckPath: /health
```

#### `DEPLOYMENT.md`

Write full docs for all 4 tiers. Structure:

```markdown
# Deployment Guide

## Tier 0 — Local Dev (Docker + ngrok)
- Prereqs
- 10-min walkthrough
- Telegram webhook registration
- Troubleshooting

## Tier 1 — Render Free + UptimeRobot (24/7 at $0)
- Prereqs
- Blueprint deploy
- Environment setup
- UptimeRobot configuration (ping every 5 min to https://{service}.onrender.com/healthz)
- Caveats (750 hrs/mo, cold starts, SQLite not Postgres)

## Tier 2 — Railway / Heroku ($5/mo)
- Railway Blueprint
- Heroku equivalent
- Postgres included
- No cold starts

## Tier 3 — Hetzner VPS ($4.59/mo)
- CX22 setup
- Caddy reverse proxy for HTTPS
- Docker Compose production config
- systemd service for resilience
- Backup script (daily pg_dump to S3)

## Tier 4 — n8n Cloud ($20/mo)
- Import workflow JSON
- Env var setup
- Zero ops, managed
- Execution limits (2500/mo)
```

#### `API.md`

Full content with:
- TL;DR summary table (all services, free tiers, purposes)
- OpenRouter deep-dive ($10 → 1000/day unlock, how to do the deposit, which models to use)
- Per-service setup guide (signup URLs, credential flow, quotas, gotchas)
- Realistic monthly cost estimate table
- Troubleshooting section (429 errors, credential expiry, quota exhaustion)

#### `docs/ARCHITECTURE.md` + `docs/diagrams/*.mmd`

4 mermaid diagrams:
1. `system_overview.mmd` — the one in the README
2. `apply_pipeline.mmd` — full PDF generation flow
3. `outreach_rrf.mmd` — Switch + fan-out + RRF merge
4. `deployment_tiers.mmd` — 4 hosting options visualized

Each embedded in ARCHITECTURE.md with explanatory prose between diagrams.

**Acceptance criteria:**
- `docker compose up` on a fresh clone produces a working n8n instance
- `render.yaml` validates with Render's blueprint linter
- `API.md` contains setup URLs and cost math that's verifiable against live docs
- Mermaid diagrams render cleanly in GitHub

**Commit:** `"feat(deploy): Session 7 — deployment configs + API docs + architecture diagrams"`

---

### Session 8 — README polish + LinkedIn announcement

**Goal:** Final presentation layer. Write the LinkedIn announcement. Polish README. Tag v1.0.0.

**Deliverables:**

1. **README polish** — final voice pass, verify all diagrams render, all links work, status badges accurate.

2. **`docs/LAUNCH_POST.md`** — LinkedIn announcement draft. Tone: casual, builder-to-builder, short punchy sentences, specific details, dry humor, triplet closers (à la EZ OnCall post). Structure:
   - Hook: "What if job hunting was a Telegram chat?"
   - What it is in 3 sentences
   - Show, don't tell (concrete example: user texts "apply 3", gets PDFs)
   - The technical flex (one paragraph on the Switch-RRF-fan-out pattern, $10/1000/day unlock, three LaTeX skeletons)
   - Cost reality check ("$10 + ~$2/mo")
   - Link to repo
   - Triplet close

3. **Tag `v1.0.0`** + GitHub release notes.

**Acceptance criteria:**
- README is lint-clean, all links functional
- LinkedIn post reads naturally, under 1300 characters (LinkedIn's optimal length)
- Repo is ready to share publicly

**Commit:** `"chore: Session 8 — launch polish + v1.0.0"`

---

## Part 6: Reference Material

### 6.1 RRF merge — full JavaScript implementation (for the Code node in Session 6)

```javascript
// ═══════════════════════════════════════════════════════════════
// RRF Merge — Reciprocal Rank Fusion for multi-provider search
// ═══════════════════════════════════════════════════════════════
// Input: items from Merge node, each with shape:
//   { source: 'firecrawl'|'youcom'|'serper', results: [{url, title, snippet, content?}, ...] }
// Output: top 15 deduped results, sorted by RRF score.

const k = 60;  // RRF smoothing constant (standard)
const topN = 15;

// Normalize URL for comparison (strip tracking params, trailing slashes)
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Strip common tracking params
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid']
      .forEach(p => u.searchParams.delete(p));
    // Strip trailing slash from path
    let normalized = u.origin + u.pathname.replace(/\/$/, '') + u.search;
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const fused = new Map();

// Process each provider's results
for (const item of $input.all()) {
  const source = item.json.source;
  const results = item.json.results || [];
  
  results.forEach((result, rank) => {
    if (!result.url) return;
    const key = normalizeUrl(result.url);
    
    const existing = fused.get(key) || {
      url: result.url,
      title: result.title || '',
      snippet: result.snippet || '',
      content: result.content || '',
      sources: [],
      score: 0
    };
    
    // RRF formula: 1 / (k + rank)
    existing.score += 1 / (k + rank + 1);
    existing.sources.push(source);
    
    // Prefer the longest content version from any provider
    if ((result.content || '').length > existing.content.length) {
      existing.content = result.content;
    }
    // Prefer non-empty title
    if (!existing.title && result.title) {
      existing.title = result.title;
    }
    // Prefer longer snippet
    if ((result.snippet || '').length > existing.snippet.length) {
      existing.snippet = result.snippet;
    }
    
    fused.set(key, existing);
  });
}

// Sort by score desc, take top N
const merged = Array.from(fused.values())
  .sort((a, b) => b.score - a.score)
  .slice(0, topN);

// Return in n8n format
return merged.map(r => ({ json: r }));
```

### 6.2 LaTeX helper functions

Port these directly from `D:\My-Projects\Career_Forge_Development\Career_Forge_Web\server\resumeforge.ts`. They're production-tested. Key functions:
- `escapeLatexText` — full 10-character escape (see Session 5)
- `sanitizeResumeContentBlock` — strips banned commands, normalizes skills block, balances macro pairs
- `wrapResumeWithSkeleton` — marker-based injection between `%%% HEADER_START/END` and `%%% CONTENT_START/END`
- `extractBetweenMarkers` — extracts LLM output from within marker pair

`normalizeLatexForPdflatex` lives in `latex.ts` — port into `services/latex/app.py` as a Python function applied before the pdflatex call. It strips smart quotes, em-dashes, currency symbols (₹€£), and non-ASCII.

### 6.3 Switch node config (n8n JSON snippet for outreach/intel search fan-out)

```json
{
  "parameters": {
    "mode": "rules",
    "rules": {
      "values": [
        {
          "conditions": {
            "options": { "version": 2, "caseSensitive": false },
            "conditions": [
              {
                "leftValue": "={{ $env.FIRECRAWL_API_KEY }}",
                "rightValue": "",
                "operator": { "type": "string", "operation": "notEmpty" }
              }
            ]
          },
          "outputKey": "firecrawl"
        },
        {
          "conditions": {
            "conditions": [
              {
                "leftValue": "={{ $env.YOUCOM_API_KEY }}",
                "rightValue": "",
                "operator": { "type": "string", "operation": "notEmpty" }
              }
            ]
          },
          "outputKey": "youcom"
        },
        {
          "conditions": {
            "conditions": [
              {
                "leftValue": "={{ $env.SERPER_API_KEY }}",
                "rightValue": "",
                "operator": { "type": "string", "operation": "notEmpty" }
              }
            ]
          },
          "outputKey": "serper"
        }
      ]
    },
    "options": {
      "fallbackOutput": "extra",
      "sendToAllMatches": true
    }
  },
  "type": "n8n-nodes-base.switch",
  "typeVersion": 3
}
```

### 6.4 API credential setup — quick reference

#### OpenRouter ($10 → 1000/day)
1. Sign up: https://openrouter.ai/sign-up
2. Go to Credits → Add $10 via Stripe
3. Keys → Create Key → copy `sk-or-v1-...`
4. **Unlock verification:** Make 51 free model calls in one day — if the 51st succeeds, you're on the 1000/day tier
5. Firecrawl plugin: Settings → Plugins → Web Search → select Firecrawl engine → accept ToS → this auto-creates a Firecrawl account with 100K Hobby-plan credits

#### You.com ($100 free)
1. Sign up: https://api.you.com (no credit card needed)
2. Dashboard → API Keys → Create → copy the key
3. Free tier: $100 credits. Web Search API = $5/1K queries = 20K queries. LiveCrawl (full page content) is INCLUDED in the flat rate.
4. Header: `X-API-Key: YOUR_KEY`

#### Serper (2500 one-time)
1. Sign up: https://serper.dev/signup (no credit card)
2. Dashboard → API Keys → copy
3. 2,500 credits granted ONCE on signup. No monthly refresh.
4. Header: `X-API-KEY: YOUR_KEY`

#### Firecrawl (via OpenRouter plugin)
See OpenRouter step 5 above. You get 100K credits on the Hobby plan, API key from Firecrawl dashboard. No separate signup needed.

#### Telegram Bot
1. Message `@BotFather` on Telegram
2. `/newbot` → follow prompts → receive token
3. Set the webhook after workflow deploy: `https://api.telegram.org/bot{TOKEN}/setWebhook?url={WEBHOOK_URL}/webhook/telegram`

### 6.5 Known gotchas (document in docs/QUICKSTART.md)

- **n8n Switch bug in some versions:** Avoid `contains` and `starts with` operators — they can misroute items to fallback. Use `is not empty`, `equals`, or `regex match` instead.
- **pdflatex Unicode:** Strips ₹/€/£ currency symbols and smart quotes in `normalizeLatexForPdflatex`. If user's resume has these, they get substituted (e.g., ₹ → "INR ").
- **Telegram file captions:** Max 1024 characters. Long captions fail silently — truncate before sending.
- **OpenRouter free model rate limits:** Even on the 1000/day tier, per-provider limits apply. If DeepSeek is throttled, fall back to Llama 3.3 70B :free.
- **Render free tier Postgres:** Expires after 30 days. Use SQLite + persistent disk instead for long-term free hosting.
- **n8n Basic LLM Chain has no memory.** Only AI Agent nodes support Chat Memory. Don't try to use memory on a chain — it'll silently produce incorrect context-free outputs.
- **Firecrawl via OpenRouter plugin is not exposed in the native OpenRouter Chat Model sub-node.** To use Firecrawl in n8n, use direct HTTP Request to Firecrawl API with the API key you got from the plugin signup.

### 6.6 Existing production code reference (READ these before Session 3 and 5)

All in `D:\My-Projects\Career_Forge_Development\Career_Forge_Web\server\`:

- **`resumeforge.ts`** — the gold standard. Shows the MEGA prompt loading pattern, marker-based extraction, skeleton wrapping, sanitization. Port the architecture 1:1.
- **`coverforge.ts`** — cover letter generation with JSON error handling. Shows how to gate on metric-rich bullets.
- **`latex.ts`** — `compileLatexToPdf` with timeout, stderr excerpt extraction for debugging, Unicode normalization.
- **`coverpdf.ts`** — `renderCoverLetterToLatex` with `{{BODY}}` skeleton replacement.
- **`routers.ts`** — `contacts.discover` (the Serper + LLM extraction pattern — replicate this in the outreach branch), `intel.companyHealth` (the company intel multi-query pattern).

---

## Part 7: How to Use This Plan with an Agent

### Option A (recommended): Claude Code

```bash
# One-time setup
cd D:\My-Projects\Career_Forge_Development\careerforge_n8n
# Ensure PLAN.md exists at repo root

# Execute session-by-session
claude "Read PLAN.md. Execute Session 1 only. Commit when done."
# Review the commit, then:
claude "Read PLAN.md. Execute Session 2."
# ...and so on through Session 8
```

Claude Code reads `CLAUDE.md` by convention if present. Consider dropping a minimal `CLAUDE.md` that just says: "This is CareerForge n8n. The full execution plan is in PLAN.md. Follow it session-by-session."

### Option B: Warp / Oz

```
In Warp terminal, open careerforge_n8n folder.
Start Oz session: "Read PLAN.md, execute Session 1, commit."
Review commit. Continue session-by-session.
```

Warp's WARP.md file already has project context. Oz will pair that with PLAN.md.

### Option C: Manus

Paste this PLAN.md into Manus as the task description. Manus handles multi-file generation well. Say: "Execute Session 1. Show me the diff before committing."

### Option D: Manual execution

Treat this as a checklist. Go session by session. Each session's "Deliverables" and "Acceptance criteria" are your definition-of-done.

---

## Part 8: What to do AFTER Session 8

- **Public launch:** Push to github.com/Career-Forge/n8n, tag v1.0.0, post LinkedIn announcement from Session 8 draft.
- **Community:** n8n community template submission, Reddit r/n8n, Hacker News "Show HN".
- **Iterate based on feedback:** The README's Status section invites contributors. Watch issues.
- **Monetization path (optional, future):** Keep this open source forever. If there's genuine demand, build a hosted tier that just gives people an n8n Cloud instance pre-loaded with the workflow for $10/mo.

---

## Appendix A: `scaffold_session1.ps1` (full script)

[Full script from the previous message — copy as-is into repo root and run from Warp/Oz]

## Appendix B: `README.md` (commit-ready, Session 1 deliverable)

[Full README from the previous message — copy as-is, overwrite existing]

## Appendix C: Minimal `CLAUDE.md` for Claude Code

```markdown
# CareerForge n8n

AI-powered job search Telegram bot built in n8n.

## Execution plan
The full refactor plan is in **PLAN.md**. Follow it session-by-session.
Each session produces one git commit.

## Key decisions (do not re-litigate — locked in PLAN.md Part 2):
- One Telegram bot, 10 intents, one workflow file
- OpenRouter for all LLM work
- Three LaTeX skeletons (fresher/experienced/senior)
- RRF merge for multi-provider search fan-out
- Apollo.io stays user-side (Chrome extension)

## Voice
Pranav's writing style: casual, builder-to-builder, short punchy sentences,
specific details, dry humor. Match this in README / LinkedIn post / comments.

## Tech stack
n8n (self-hosted Docker), OpenRouter, Firecrawl, You.com, Serper,
Flask+pdflatex service, Telegram Bot API.
```

````