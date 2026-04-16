# CareerForge Nexus -- Master TODO
> Last updated: April 11, 2026
> Goal: The most ambitious AI-powered career intelligence system ever built in n8n

---

## CONTEXT & ARCHITECTURE DECISIONS

### What we have across three repos:
- **careerforge_n8n** -- Production n8n workflows (job discovery, PDF generation, LaTeX service, Telegram bot v4 live)
- **careerforge_Telegram** -- 4-avatar multi-bot system (Brian, Marcus, Ryan, Rita) with FastAPI + Claude Opus 4.6
- **Career_Forge_Agent** -- Enterprise TypeScript monorepo (A2A architecture, MemoryVaultAgent, tRPC, Drizzle, Discord/Slack scaffolded)

### Key architectural decision:
> n8n = workflow engine | Avatar system (careerforge_Telegram) = conversational face
> Avatars call n8n workflows via HTTP. n8n returns results. Avatars present them.
> This is EXACTLY what `careerforge_Telegram/src/n8n/triggers.py` was already planning.

### Trigger schedule (data-backed):
- **8:00 AM ET** -- catch overnight postings
- **11:30 AM ET** -- catch the 11am posting spike (within first-apply window)
- Weekdays only (Mon-Fri)

---

## SPRINT 1 -- INFRASTRUCTURE & PERSISTENCE
> Priority: HIGHEST -- everything else depends on this

### 1.1 ChromaDB Vector Database
- [ ] Add `chroma-service` to `docker/docker-compose.yml`
  ```yaml
  chroma-service:
    image: chromadb/chroma:latest
    container_name: careerforge_chroma
    restart: unless-stopped
    ports:
      - "8001:8000"
    volumes:
      - chroma_data:/chroma/chroma
    networks:
      - careerforge_net
  ```
- [ ] Add `chroma_data` volume to volumes section
- [ ] Verify ChromaDB is reachable at `http://localhost:8001`
- [ ] Create a simple Python test script to confirm connection

### 1.2 ChromaDB Collections Design
Five collections to create and manage:

| Collection | Content | Metadata fields |
|---|---|---|
| `master_resume` | Chunked resume text (by section) | section, date_updated, version |
| `job_history` | Every job seen/applied | company, score, date, status, applied_bool, file_paths |
| `generated_docs` | Summaries of resume + CL generated | job_title, company, date, resume_path, cl_path |
| `user_preferences` | Location, visa, role prefs, salary range | chat_id, key, value, updated_at |
| `conversation_memory` | Key decisions, context, avatar conversations | source_avatar, date, intent, chat_id |

### 1.3 Local Storage Folder Structure
- [ ] Create `D:\My-Projects\Career_Forge_Development\careerforge_n8n\storage\` with:
  ```
  storage/
  ├── master_resume/
  │   └── pranav_resume_latest.pdf  (master PDF)
  ├── applications/
  │   └── {company}_{date}/
  │       ├── resume.pdf
  │       └── cover_letter.pdf
  ├── job_cache/
  │   └── {date}_jobs.json          (daily job snapshot)
  └── exports/
      └── application_tracker.csv
  ```
- [ ] Mount storage volume into n8n container in docker-compose
- [ ] Mount storage volume into latex-service container

### 1.4 ChromaDB HTTP Microservice (lightweight wrapper)
> n8n can't call ChromaDB Python SDK directly -- needs an HTTP wrapper
- [ ] Create `chroma-api/` directory alongside `latex-service/`
- [ ] Build Flask API with endpoints:
  - `POST /memory/upsert` -- store/update any memory
  - `POST /memory/query` -- semantic search
  - `GET /preferences/{key}` -- get user preference
  - `POST /preferences` -- set user preference
  - `POST /jobs/store` -- store job with metadata
  - `GET /jobs/history` -- get application history
  - `POST /resume/update` -- chunk and embed master resume
- [ ] Add `chroma-api` service to docker-compose (port 5680)
- [ ] Write Dockerfile for chroma-api

---

## SPRINT 2 -- UNIFIED WORKFLOW (THE BIG ONE)
> Replace all existing 06_telegram_bot_v4 with one master workflow

### 2.1 Three Triggers
- [ ] **Telegram Trigger** -- message-based, passes to Brian router
- [ ] **Schedule Trigger** -- cron `0 8 * * 1-5` (8am ET weekdays) + `30 11 * * 1-5` (11:30am ET weekdays)
- [ ] **Manual Trigger** -- n8n UI execution with parameter form

### 2.2 Normalize Input Node
> Unify all three trigger formats into one schema
- [ ] Output standard object: `{ source, text, chat_id, trigger_type, params }`
- [ ] Schedule triggers: `intent = "digest"`, skip Brian
- [ ] Manual triggers: intent from form field, skip Brian

### 2.3 Load Context from ChromaDB
> Every execution starts by loading user state
- [ ] HTTP GET to chroma-api for preferences (location, visa, salary range, role targets)
- [ ] HTTP GET for last 3 jobs seen (for "apply to X" context)
- [ ] HTTP GET for resume version/last-updated date

### 2.4 Brian the Router (GPT-5.4-nano)
> Only runs for Telegram messages, not schedule/manual
- [ ] Intent classification:
  - `find_jobs` -- "find me AI jobs in NYC", "latest jobs", "job digest"
  - `apply` -- "apply to 3", "generate resume for job 2", just a number
  - `intel` -- "tell me about Stripe", "company research Anthropic"
  - `interview_prep` -- "interview prep for Anthropic", "practice questions"
  - `salary_coach` -- "salary negotiation help", "counter offer advice"
  - `set_preference` -- "set my location to NYC", "I need H-1B sponsorship"
  - `tracker` -- "show my applications", "application status"
  - `help` -- anything else
- [ ] Extract: location override, visa flag, company name, job number, preference key/value
- [ ] Parse temporary preference overrides (e.g. "just this time, search in London")

### 2.5 Switch by Intent (8 branches)

#### Branch 0: FIND JOBS
- [ ] Define Companies (10 random from pool of 25, Fisher-Yates shuffle)
- [ ] Fetch ATS Jobs (Greenhouse public API, parallel GET requests)
- [ ] Aggregate + Filter (keyword filter for AI/ML/engineering roles)
- [ ] Extract & Score Jobs (Gemini 3 Flash -- score ≥7, location filter, visa filter)
- [ ] Store jobs to ChromaDB (job_history collection)
- [ ] Format table (numbered list with score, location, URL, visa flag)
- [ ] Send to Telegram

#### Branch 1: APPLY
- [ ] Load stored job from ChromaDB (by number from last search)
  - Fallback: if no stored job, request JD URL
- [ ] Scrape JD via Firecrawl (if URL provided)
- [ ] Load master resume from ChromaDB (latest chunks)
- [ ] ForgeScore (Gemini 3 Flash -- score resume vs JD)
  - Gate: score ≥ 6 to proceed
- [ ] ResumeForge (Claude Sonnet 4.6 -- JSON bullets only, not full resume)
- [ ] Build LaTeX from template + JSON bullets (code node)
- [ ] Compile PDF (HTTP POST to latex-service:5679/compile)
- [ ] CoverForge (Claude Sonnet 4.6 -- 350-450 words, 3 paragraphs, human tone)
- [ ] Save PDFs to storage/applications/{company}_{date}/
- [ ] Store to ChromaDB (generated_docs collection)
- [ ] Store to ChromaDB (job_history -- mark as applied=true)
- [ ] Send resume PDF via Telegram sendDocument
- [ ] Send cover letter text via Telegram sendMessage
- [ ] Optional: auto-save to Google Drive (if connected)

#### Branch 2: COMPANY INTEL
- [ ] Serper.dev -- recent news (last 7 days)
- [ ] You.com -- company profile + funding + tech stack
- [ ] You.com -- contact finder (hiring manager)
- [ ] Risk Assessor (Gemini 3 Flash -- visa sponsorship history, layoff risk, growth signals)
- [ ] Intel Synthesizer (Claude Sonnet 4.6 -- narrative company brief)
- [ ] Outreach Writer (Claude Sonnet 4.6 -- personalized LinkedIn message draft)
- [ ] Format and send to Telegram (company brief + outreach draft)

#### Branch 3: INTERVIEW PREP
- [ ] Load job details from ChromaDB OR accept company/role from message
- [ ] Load master resume from ChromaDB
- [ ] Generate 20 likely interview questions (role-specific + company-specific)
- [ ] Generate STAR-format answers for each based on resume
- [ ] Organize by category (behavioral, technical, system design, culture fit)
- [ ] Format as numbered list with answers
- [ ] Send to Telegram (paginated -- 5 questions per message to avoid length limits)

#### Branch 4: SALARY COACH
- [ ] Extract company + role from message or ChromaDB (last applied job)
- [ ] Search Levels.fyi data via Serper (salary ranges for role/company)
- [ ] Generate negotiation script (Claude Sonnet 4.6)
  - Opening ask, counter-offer responses, equity discussion, benefits
- [ ] Generate 5 negotiation scenarios with sample dialogues
- [ ] Send to Telegram

#### Branch 5: SET PREFERENCE
- [ ] Parse key/value from Brian's extraction
  - `location` → "New York", "Remote", "San Francisco"
  - `visa_required` → true/false
  - `salary_min` → number
  - `role_targets` → ["AI Engineer", "ML Engineer", "Data Scientist"]
  - `experience_level` → "senior", "staff", "principal"
- [ ] HTTP POST to chroma-api to upsert preference
- [ ] Confirmation message to Telegram: "✅ Got it! Location set to New York. I'll filter jobs within 100km."
- [ ] Support temp overrides: "just this time, search in London" → doesn't persist

#### Branch 6: APPLICATION TRACKER
- [ ] HTTP GET to chroma-api for job_history (applied=true)
- [ ] Format as status table:
  - Company | Role | Date Applied | Status | Score
- [ ] Status options: Applied / Interviewing / Rejected / Offer / Withdrawn
- [ ] Allow status update: "update Stripe to interviewing"
- [ ] Send formatted table to Telegram

#### Branch 7: HELP
- [ ] Send comprehensive help message with all commands
- [ ] Include examples for each intent
- [ ] Show current preferences summary

### 2.6 Scheduled Digest (auto-triggered at 8am + 11:30am)
- [ ] Runs FIND JOBS branch directly (skip Brian)
- [ ] Takes top 5 jobs scoring ≥ 8
- [ ] Adds salary intel from Levels.fyi for each (if available)
- [ ] Adds one-line company snapshot for each
- [ ] Sends formatted digest to Telegram
- [ ] Stores all jobs to ChromaDB

### 2.7 Smart Respond (unified output node)
- [ ] Check `source` field:
  - `telegram` → send via Telegram nodes
  - `manual` → respond to webhook / show in n8n UI
  - `schedule` → send via Telegram (chat_id from preferences)
- [ ] Handle document vs message distinction automatically

---

## SPRINT 3 -- AVATAR INTEGRATION
> Bring careerforge_Telegram avatars into the unified system

### 3.1 Avatar System Setup
- [ ] Clone/copy `careerforge_Telegram` into `careerforge_n8n/avatars/`
- [ ] Update docker-compose to include FastAPI avatar service (port 8000)
- [ ] Configure 4 bot tokens in .env:
  - `TELEGRAM_BRIAN_TOKEN`
  - `TELEGRAM_MARCUS_TOKEN`
  - `TELEGRAM_RYAN_TOKEN`
  - `TELEGRAM_RITA_TOKEN`
- [ ] Wire Brian's FastAPI webhook to call n8n workflows via HTTP instead of running internally

### 3.2 Avatar Personalities (from prompts/)
- [ ] **Brian** -- routes + budgets. Knows all intents. Calls n8n for execution.
- [ ] **Marcus (Tier 1)** -- career strategy, offer negotiation, big-picture. "Should I take this?"
- [ ] **Ryan (Tier 2)** -- resume architect. "Tweak bullet 3", "make it sound more senior". Calls APPLY branch.
- [ ] **Rita (Tier 2)** -- company researcher + job discoverer. Calls INTEL + FIND branches.

### 3.3 Interaction Modes
- [ ] **Direct mode** -- @mention specific avatar: `@ryan update my summary`
- [ ] **Council mode** -- open question, all avatars weigh in in parallel
- [ ] **Pipeline mode** -- "full prep for Anthropic" → Rita → Marcus → Ryan sequential

### 3.4 Budget Tracker
- [ ] Max 15 LLM calls per thread (configurable)
- [ ] Track per chat_id in ChromaDB
- [ ] Graceful budget-exceeded message from Brian

---

## SPRINT 4 -- MULTI-CHANNEL A2A
> Expand beyond Telegram while keeping Brian as the single interface

### 4.1 Google Calendar Integration (MCP already connected)
- [ ] New intent: `schedule_interview` -- "interview at Stripe Thursday 2pm"
- [ ] Auto-create calendar event with:
  - Company + role in title
  - Job URL in description
  - 24h prep reminder (sends interview prep to Telegram)
  - 1h reminder (sends key talking points)
- [ ] "Check my schedule" -- pull upcoming interviews from Calendar
- [ ] Pre-interview automation: 24h before → auto-trigger interview prep branch

### 4.2 Gmail Integration (MCP already connected)
- [ ] Monitor inbox for recruiter emails (filter by keywords + sender patterns)
- [ ] Auto-detect: interview invite, rejection, request for more info
- [ ] Draft response templates for each scenario
- [ ] Update application tracker automatically when email detected
- [ ] "Check recruiter emails" -- summarize last 7 days of job-related emails
- [ ] Follow-up reminder: no response in 7 days → draft follow-up email

### 4.3 SMS via Twilio (ultra-urgent only)
- [ ] Trigger only for: 10/10 match job posted, interview invite received, offer received
- [ ] Simple text: "CareerForge Alert: 10/10 match at Anthropic just posted. Check Telegram."
- [ ] Configurable threshold (default: score ≥ 9 for SMS alert)

### 4.4 Discord (already scaffolded in Career_Forge_Agent)
- [ ] Same 4 avatars available in Discord server
- [ ] Same intent routing via Brian
- [ ] Slash commands: `/find`, `/apply`, `/intel`, `/prep`
- [ ] Job digest in dedicated `#job-digest` channel

### 4.5 Google Drive Auto-Save
- [ ] After every APPLY branch: copy resume PDF + cover letter to Drive
- [ ] Folder structure: `CareerForge/{Company}/{Date}/`
- [ ] Send Drive link in Telegram after document delivery
- [ ] Weekly: export application_tracker.csv to Drive

### 4.6 n8n MCP Integration
- [ ] Expose n8n workflow triggers via MCP server endpoints
- [ ] Allow Claude (this conversation!) to trigger workflows directly
- [ ] Useful for: testing, manual overrides, bulk operations

---

## SPRINT 5 -- INTELLIGENCE LAYER

### 5.1 Interview Prep Engine (already in Branch 3, needs depth)
- [ ] Pull actual Glassdoor interview questions via Serper
- [ ] Generate company-specific technical questions (based on job stack)
- [ ] Generate behavioral questions with STAR templates
- [ ] Rate each answer draft 1-10 with improvement notes
- [ ] Save full prep set to storage/interview_prep/{company}/
- [ ] Optional: send as PDF via latex-service

### 5.2 Salary Intelligence
- [ ] Levels.fyi scrape via Firecrawl for role + company + location combo
- [ ] Glassdoor data via Serper news search
- [ ] LinkedIn salary insights via Serper
- [ ] Generate salary range with:
  - Base, total comp (with equity), bonus
  - Percentile placement (where your ask falls)
  - Counter-offer strategy
- [ ] Negotiation simulator: Claude Sonnet role-plays as recruiter, you practice

### 5.3 ATS Shadow Scoring
- [ ] Simulate ATS keyword extraction from JD
- [ ] Run your resume through same extraction
- [ ] Calculate overlap score (ATS-specific, not semantic)
- [ ] Highlight missing keywords
- [ ] Suggest specific additions without fabricating experience

### 5.4 Career Trajectory Analysis
- [ ] Given resume, generate 3 career path options:
  - Path A: Upward (next seniority level, same domain)
  - Path B: Pivot (adjacent domain, leverage transferable skills)
  - Path C: Moonshot (ambitious target, 2-3 year plan)
- [ ] For each path: required skills, timeline, target companies, salary jump
- [ ] Store as persistent career goals in ChromaDB

### 5.5 LinkedIn Outreach Generator
- [ ] Given company + target role, find hiring manager name via You.com
- [ ] Generate personalized cold outreach message (not template)
  - References specific company work
  - Ties to your relevant experience
  - Ends with specific ask (not generic "connect")
- [ ] Generate connection request note (300 char limit)
- [ ] Generate follow-up message (if no response in 1 week)

### 5.6 Job Expiry Tracker
- [ ] Daily cron: re-check Greenhouse API for all stored active jobs
- [ ] If job disappears → mark as expired in ChromaDB
- [ ] Alert: "Job #3 (Anthropic Applied AI Engineer) is no longer posted. Still want to apply?"
- [ ] Track average time-to-close per company (interesting analytics)

### 5.7 Referral Finder
- [ ] Given target company, search LinkedIn connections via Serper
  - "site:linkedin.com {company} engineer" + cross-reference
- [ ] Generate referral request message personalized to connection
- [ ] Track who was contacted in ChromaDB

---

## SPRINT 6 -- MOONSHOT FEATURES

### 6.1 Voice Mode (ElevenLabs already in Career_Forge_Agent env)
- [ ] Telegram voice message → Whisper transcription → intent routing
- [ ] Text responses → ElevenLabs TTS → voice note reply
- [ ] "Read me my job digest" → audio digest delivered to Telegram
- [ ] Voice interview practice: you speak answers, AI coaches in real-time

### 6.2 Auto-Apply Mode (EXPLICIT USER COMMAND ONLY)
- [ ] User must explicitly say "auto-apply mode on" to activate
- [ ] Firecrawl Actions to fill ATS forms autonomously
- [ ] Supported ATS: Greenhouse, Lever, Ashby (all use standard form patterns)
- [ ] Review queue: shows what it's about to submit, requires confirmation
- [ ] Rate limiting: max 10 applications per day (avoid recruiter fatigue)
- [ ] Full audit trail in ChromaDB

### 6.3 Offer Comparison Matrix
- [ ] User inputs multiple offers via Telegram
- [ ] Side-by-side comparison:
  - Base salary, total comp, equity vesting, bonus
  - Location cost-of-living adjusted salary
  - Company stage, growth trajectory
  - Visa sponsorship continuity
  - PTO, benefits, remote policy
- [ ] Weighted scoring (user-configurable weights)
- [ ] Final recommendation from Marcus avatar
- [ ] Export as PDF table via latex-service

### 6.4 Market Intelligence Dashboard
- [ ] Weekly report: AI job market trends
  - Which companies are hiring most (from job counts)
  - Which skills are most demanded (from JD keyword frequency)
  - Salary trend vs last week
  - New companies appearing in AI hiring
- [ ] Delivered as formatted Telegram message every Monday 8am

### 6.5 Network Graph
- [ ] Build graph of: companies → roles → your connections → hiring managers
- [ ] Identify warm introduction paths
- [ ] "Who do I know at Anthropic?" -- traverses network
- [ ] Stored in ChromaDB as relationship vectors

---

## INFRASTRUCTURE TASKS (ONGOING)

### Docker Services Final State
```
careerforge_n8n       -- port 5678 (n8n workflow engine)
careerforge_latex     -- port 5679 (LaTeX → PDF compiler) ✅ RUNNING
careerforge_chroma    -- port 8001 (ChromaDB vector store) [ ] TODO
careerforge_chroma_api -- port 5680 (ChromaDB HTTP wrapper) [ ] TODO
careerforge_avatars   -- port 8000 (FastAPI avatar system) [ ] TODO
```

### Environment Variables to Add
```
# ChromaDB
CHROMA_URL=http://chroma-service:8000
CHROMA_API_URL=http://chroma-api-service:5680

# Avatar system
TELEGRAM_BRIAN_TOKEN=
TELEGRAM_MARCUS_TOKEN=
TELEGRAM_RYAN_TOKEN=
TELEGRAM_RITA_TOKEN=

# New integrations
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
TWILIO_TO_NUMBER=

ELEVENLABS_API_KEY=

GOOGLE_DRIVE_FOLDER_ID=
```

### ngrok / Tunnel
- [ ] ngrok URL changes on every restart -- automate update to N8N_WEBHOOK_URL in .env
- [ ] Consider: ngrok paid plan with static domain ($8/mo) -- would eliminate this pain forever
- [ ] Alternative: Cloudflare Tunnel with named tunnel (free, persistent)

---

## CURRENT STATUS SNAPSHOT (April 11, 2026)

### ✅ WORKING RIGHT NOW
- Workflow 06 -- CareerForge Telegram Bot v4 (PUBLISHED)
- Greenhouse API job discovery (25 company pool, 10 random per run)
- ForgeScore (Gemini 3 Flash)
- ResumeForge + CoverForge (Claude Sonnet 4.6) -- text output
- Telegram bot live and responding
- LaTeX service running (port 5679) -- PDF not yet wired to n8n
- ngrok tunnel active (https://YOUR_TUNNEL_URL_HERE (ngrok or Cloudflare Tunnel))
- Scheduled triggers: 8am + 11:30am ET (in workflow but needs verification)

### 🔲 NEXT UP (Sprint 1)
1. ChromaDB service + volume (docker-compose update)
2. ChromaDB HTTP wrapper (chroma-api Flask service)
3. Storage folder structure + docker volume mounts
4. Wire latex-service into Apply branch (PDF output to Telegram)
5. Preference persistence (location, visa, salary) via ChromaDB

### ⚠️ KNOWN ISSUES
- ngrok URL resets on laptop restart → need to update .env + restart n8n
- LaTeX service is built and running but NOT YET connected to n8n workflow
- Telegram credential ID hardcoded in JSON files (must update on new import: `8vkAvDf0IpSAVPOB`)
- `staticData` (n8n global) is volatile -- lost on n8n restart. ChromaDB will fix this.
- Only Anthropic shows up often in digests (highest scoring). Pool rotation helps but needs tuning.

---

## DESIGN PRINCIPLES

1. **Brian is always the front door** -- no matter the channel, Brian routes
2. **n8n is the workflow engine** -- avatars call n8n, n8n executes, avatars present
3. **ChromaDB is the single source of truth** -- preferences, history, resume, memory
4. **PDF only for application documents** -- no half-baked text output for resume/CL
5. **User confirms before applying** -- auto-apply only on explicit command
6. **Hybrid inference** -- cheap/fast models for routing (GPT-5.4-nano), quality models for generation (Claude Sonnet 4.6)
7. **Local-first** -- all storage is local (Docker volumes), no cloud dependency for core function
8. **Channel-agnostic** -- same intent, same output, any channel (Telegram, Discord, SMS, Gmail)

---

## METRICS TO TRACK (Future)
- Jobs found per digest
- Average ForgeScore of applied jobs
- Resume-to-interview conversion rate (manually updated)
- Time from job posted → applied (target: < 2 hours for ≥9 score jobs)
- Companies with most 9+ score matches
- Most demanded skills across all JDs seen
