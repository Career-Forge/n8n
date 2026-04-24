# Master Resume Guide

Your **master resume** is a single text file containing your complete career data. CareerForge reads it every time you run `/apply` and generates a tailored resume + cover letter specific to the job description. You write it once; CareerForge adapts it for every application.

## Why This File Matters

CareerForge never invents experience. Every bullet on your tailored resume is traced back to this file. If something isn't in your master resume, it won't appear in any generated document. A thorough master resume means better output — missing metrics or vague bullets produce vague results.

## Step 1: Fill Out the Template (2 Minutes)

The fastest path is to let an AI do the data entry for you.

1. Open `templates/master_resume_template.txt` and copy the entire file
2. Go to [ChatGPT](https://chat.openai.com), [Claude](https://claude.ai), or [Gemini](https://gemini.google.com)
3. Paste the template into the chat
4. Attach or paste your current resume (PDF, DOCX, or plain text all work)
5. Send this prompt:

> Fill out this template using my resume. Keep every metric and achievement exactly as written — do not round numbers or rephrase quantified results. If you notice gaps where I likely have metrics but didn't include them (e.g., team sizes, user counts, latency numbers), flag them with [NEEDS METRIC] so I can fill them in. Return the completed template.

6. Copy the AI's output back into a new file

## Step 2: Verify the Output (3 Minutes)

AI-assisted filling is fast but not flawless. Spot-check these three things:

- **Metrics preserved:** Pick 3 bullets that had specific numbers in your original resume. Confirm the numbers match exactly — no rounding, no unit changes.
- **No role swaps:** Verify each bullet is under the correct company/role. LLMs occasionally move achievements between similar roles.
- **No hallucinated companies:** Scan the EXPERIENCES section and confirm every company listed is one you actually worked at.

If the AI flagged anything with `[NEEDS METRIC]`, fill those in now. Even rough numbers ("~50 users", "3-person team") are better than nothing.

## Step 3: Save the File

Save your completed file as `master_resume.txt` and place it at:

```
/data/user-data/master_resume.txt
```

This path is mounted into the n8n Docker container. If you're running locally with the default `docker-compose.yml`, that maps to the `user-data/` folder in the repo root.

## What CareerForge Does With It

When you trigger `/apply`:

1. **SeniorityDetector** reads your experience count and picks the right LaTeX skeleton (fresher / experienced / senior)
2. **ResumeForge** selects the most relevant bullets for the job, rewords them for keyword alignment, and returns structured JSON
3. A code node fills the LaTeX skeleton with the JSON content
4. The LaTeX service compiles it to PDF

The same master resume also feeds **ForgeScore** (resume-vs-JD scoring), **CoverForge** (cover letter generation), and **outreach** (personalizing cold messages with your background).

## What If Fields Are Missing?

CareerForge skips missing fields — it never hallucinates to fill gaps. Specifically:

- No `portfolio`? The portfolio line is omitted from the resume header.
- No `projects`? The Projects section is skipped entirely (common for senior mode).
- No `certifications`? Section omitted.
- No `summary`? Omitted in fresher and experienced modes (only used in senior mode anyway).

The only truly required fields are: **name, email, phone, location, at least one experience entry, education, and skills.**

## Troubleshooting

**"Master resume incomplete" error when running /apply**
Your file is either missing or under 200 characters. Check that `master_resume.txt` exists at `/data/user-data/master_resume.txt` and contains at least one experience entry.

**Generated resume has wrong metrics**
The AI that filled your template likely altered a number. Open your master resume, find the bullet, and correct it. CareerForge preserves metrics exactly as written in the source file.

**Resume picks the wrong seniority level**
Add an explicit override in the SENIORITY section of your master resume:
```
mode: experienced
```
Valid values: `fresher`, `experienced`, `senior`.

## Reference

- Template: [`templates/master_resume_template.txt`](../templates/master_resume_template.txt)
- Worked example: [`templates/master_resume_example.txt`](../templates/master_resume_example.txt) (fictional persona, Sarah Chen, ML Engineer)

## Next Step

With your master resume saved, you're ready to use CareerForge. Text your Telegram bot `find AI jobs` to get a job digest, then reply with a job number to generate your first tailored resume + cover letter.
