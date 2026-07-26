# Master Resume Guide

Your **master resume** is a single JSON document containing your complete career data. CareerForge reads it every time you run `apply` and generates a tailored resume + cover letter specific to the job description. You fill it out once (one-time setup, via Telegram); CareerForge adapts it for every application after that.

## Why This File Matters

CareerForge never invents experience. Every bullet on your tailored resume is traced back to this JSON. If something isn't in it, it won't appear in any generated document. A thorough master resume means better output — missing metrics or vague bullets produce vague results.

## Step 1: Get the Template

Text your bot **"set up my resume"** (or send it a resume file directly, or just start with `/apply` before you've set anything up — the bot detects the missing data and sends the template automatically). It replies with a JSON template message that looks like this:

```json
{
  "personal": {
    "name": "",
    "headline": "",
    "emails": [{ "address": "", "primary": true }],
    "phones": [{ "number": "", "primary": true, "region": "US" }],
    "links": { "linkedin": "", "github": "", "portfolio": "" },
    "location": { "city": "", "region": "", "country": "", "show_on_resume": false },
    "work_authorization": "",
    "dob": "", "nationality": "", "marital_status": "",
    "work_authorization_status": {}, "photo": "", "signature": false
  },
  "summary_bullets": [],
  "experience": [
    { "title": "", "company": "", "location": "", "start_date": "YYYY-MM", "end_date": "YYYY-MM or Present", "is_current": false, "bullets": [], "skills": [], "metrics": [] }
  ],
  "projects": [
    { "name": "", "url": "", "tech": [], "bullets": [], "metrics": [] }
  ],
  "education": [
    { "degree": "", "field": "", "institution": "", "location": "", "start_date": "YYYY-MM", "end_date": "YYYY-MM", "gpa": "", "coursework": [] }
  ],
  "skills": { "programming": [], "ai_ml": [], "data_mlops": [], "cloud_devops": [], "tools": [], "other": [] },
  "achievements": []
}
```

## Step 2: Fill It Out (an LLM does the data entry)

The bot's message includes a ready-to-use prompt block for this — copy it, paste it into ChatGPT/Claude/Gemini, then paste your existing resume (PDF, DOCX, or plain text all work) underneath it. The prompt instructs the LLM to copy facts **verbatim** — never invent, embellish, round a number, or drop a bullet.

Send the filled JSON back to your bot, either as a **`.json` file** (best for long resumes) or pasted directly as text.

## Step 3: Verify the Output

AI-assisted filling is fast but not flawless. Spot-check before sending it back:

- **Metrics preserved:** pick 3 bullets that had specific numbers in your original resume. Confirm the numbers match exactly — no rounding, no unit changes.
- **No role swaps:** verify each bullet is under the correct company/role. LLMs occasionally move achievements between similar roles.
- **No hallucinated companies:** scan `experience` and confirm every company listed is one you actually worked at.

## What CareerForge Does With It

`Ingest Resume JSON` parses what you send back — **deterministically, no LLM in this step**. It validates the structure (`personal.name` and at least one of `experience`/`projects` are required; everything else is optional), normalizes emails/phones/location, and assembles the internal resume document the rest of the pipeline reads. If the JSON is missing or malformed, it replies with a clear error and re-sends the template — nothing silently fails.

When you then trigger `apply` on a job:

1. **SeniorityDetector** classifies your career tier (fresher/junior/mid/senior) from your experience — there's one shared resume layout; tier instead drives an adaptive content plan (how many roles/projects get selected, how many bullets each gets, how long each bullet runs), enforced deterministically in code.
2. **ForgeScore** scores your fit against the job (0-10). Below the threshold, you get a warning with specific gaps before any document is generated.
3. **ResumeForge** (Claude Sonnet) selects and writes tailored bullets from your master data — keyword-aligned, metrics preserved, nothing invented — and returns structured JSON.
4. A code node deterministically renders that JSON into the resume's LaTeX, which the LaTeX service compiles to PDF.
5. **CoverForge** runs the same select-then-write pattern in parallel for the cover letter.
6. Both PDFs are delivered via Telegram.
7. Reply "make it shorter" or "more Python" to iterate — chat memory preserves context (the `revise` intent).

The same master resume also feeds `score` (resume-vs-JD scoring standalone), `intel`-adjacent outreach personalization, and `salary`.

## Locale-Specific Fields (Optional)

Six `personal` fields (`dob`, `nationality`, `marital_status`, `work_authorization_status`, `photo`, `signature`) exist purely for locale correctness -- most countries (US, India, UK, Canada...) forbid all of them on a resume, and they're never invented or inferred. A field only ever renders if BOTH are true: the job's resolved locale allows it (e.g. DACH expects a DOB/nationality/signature; Gulf countries expect a work-authorization line) AND you've explicitly provided a real value here. Leave them blank/empty/false unless you know you need them.

`work_authorization_status` is an ISO-country-keyed map, e.g. `{"AE": "Employment Visa (Transferable)"}` -- it renders only when the job's country matches a key in the map exactly, and is a different field from the free-text `work_authorization` above (which stays internal context, never printed on the document itself).

None of these six ever reach any LLM prompt -- they're read directly at render time, nowhere else.

## What If Fields Are Missing?

CareerForge skips missing fields — it never hallucinates to fill gaps:

- No `links.portfolio`? The portfolio line is omitted from the resume header.
- No `projects`? The Projects section is skipped entirely (common, and expected, at senior tier).
- No `achievements`? Section omitted.
- No `summary_bullets`? Summary is omitted for fresher/junior tiers anyway (only mid/senior render one).

The only truly required fields are: `personal.name`, and at least one entry in `experience` or `projects`.

## Troubleshooting

**Bot keeps re-sending the template instead of accepting my JSON**
Your message either wasn't valid JSON (check for a trailing comma or an unclosed brace — paste it into a JSON validator first) or was missing `personal.name` and both `experience`/`projects`. The bot's error message tells you exactly which check failed.

**Generated resume has wrong metrics**
The LLM that filled your template likely altered a number. Open your JSON, find the bullet, and correct it directly, then resend it via `setup_resume`. CareerForge renders metrics exactly as written in your JSON — it never recalculates or rounds them.

**Resume comes out at the wrong seniority tier**
SeniorityDetector infers your tier from years of experience and job titles (Staff/Principal/Director/etc. override on title alone). There's currently no manual override command — if it's consistently wrong for your situation, that's worth flagging as an issue rather than working around.

## Reference

- The template above is sent live by the `Send Resume Template` node — if this doc and what the bot actually sends ever disagree, trust the bot (this file can drift; the live workflow can't).
- Validation rules live in the `Ingest Resume JSON` node.

## Next Step

With your master resume saved, you're ready to use CareerForge. Text your bot "find AI jobs" to get a job digest, then reply with a job number to generate your first tailored resume + cover letter.
