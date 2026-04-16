# Multi-Agent Orchestration: The AI Job Search Pipeline
**Speaker:** Pranav Kowadkar
**Event:** n8n NYC Community Meetup (April 9, 2026)
**Time:** 7:05 PM (20 minutes)

---

## Pre-Demo Checklist (Do this at 6:30 PM)
1. Run `docker compose up -d` in the `careerforge_n8n/docker` folder
2. Open `http://localhost:5678` in your browser
3. Import all 5 workflows from the `workflows` folder
4. Open the **Master Orchestration** workflow and leave it on screen
5. Open Telegram on your phone or desktop
6. Open your terminal to the `docker` folder

---

## Act 1: The Problem (3 mins)

**[Slide 1: Title Slide]**
"Hi everyone, I'm Pranav. Tonight I want to talk about something we all hate: the modern job search."

**[Slide 2: The Manual Grind]**
"Right now, applying for a job looks like this:
1. You search LinkedIn and Indeed.
2. You find a job.
3. You copy the JD into ChatGPT.
4. You paste your resume into ChatGPT.
5. You ask it to tailor your resume.
6. You ask it to write a cover letter.
7. You go to Hunter.io to find the recruiter's email.
8. You go back to ChatGPT to write the outreach email.

It takes 45 minutes per application. It's a manual, fragmented grind. But we are n8n builders. We don't do manual."

**[Slide 3: The CareerForge Architecture]**
"So I built CareerForge. It's a multi-agent system built entirely in n8n that automates this entire pipeline. It uses a 'Hybrid Agent' philosophy: deterministic nodes for scraping and searching, and GenAI nodes for reasoning and writing.

Let me show you what it looks like."

---

## Act 2: The Live Demo (10 mins)

*(Switch screen to the n8n Master Orchestration canvas)*

"This is the Master Orchestration workflow. It's the brain of the system. It has a single entry point \u2014 a webhook that also connects to Telegram.

Instead of clicking buttons, I just talk to it."

*(Open Telegram on screen)*

"Let's say I'm looking for a new role. I'll just send:
> *'Find me Senior ML Engineer jobs in New York'* "

*(Switch back to n8n canvas quickly so they can see the nodes light up)*

"Watch the canvas. The message hits **Brian the Router** \u2014 a fast GPT-4.1-nano node. Brian reads the intent, realizes I want to find jobs, and routes the execution to the **Job Discovery** sub-workflow."

*(Open the Job Discovery workflow in a new tab)*

"Inside Job Discovery, n8n is firing parallel searches to Serper.dev and JSearch simultaneously. It merges the results, deduplicates them, and then passes them to a **Fit Scorer** \u2014 a GPT-4.1-mini node that scores each job against my master resume.

Jobs under a 6/10 are silently discarded. The good ones get a market intelligence summary from Gemini Flash."

*(Switch back to Telegram)*

"And here's the result." *(Show the structured JSON or Telegram message with the top jobs)*.

### The Showstopper: Full Pipeline Mode

"Finding jobs is cool. But let's do the whole 45-minute process in one message."

*(In Telegram, type:)*
> *'Run the full pipeline for Stripe'*

*(Switch to n8n Master Orchestration canvas)*

"Watch the routing now. Brian classifies this as `full_pipeline`.
1. First, it calls Job Discovery to find the best open role at Stripe.
2. It takes that job URL and passes it to the **Company Intel** branch.
3. Company Intel fires 3 parallel searches: News, Web, and Hunter.io for contacts. It runs sentiment analysis and flags risks.
4. Finally, it passes the job URL *and* the company intel into the **Application Forge** branch.
5. Application Forge scrapes the JD, scores my resume, tailors my bullet points to match the ATS keywords, and writes a cover letter that actually references the recent news it just found in the Intel branch."

*(Wait for execution to finish \u2014 about 15 seconds in demo mode)*

"And we're done. In 15 seconds, n8n just did 45 minutes of work."

*(Show the final output JSON or Telegram message showing the tailored resume, cover letter, and recruiter email draft)*

---

## Act 3: The Architecture & Takeaways (5 mins)

"How does this actually work under the hood? Three key architectural choices make this possible in n8n:"

**1. Sub-Workflow Chaining**
"If I put all of this in one canvas, it would be 100 nodes long and impossible to debug. By using the `Execute Workflow` node, I treat each branch like a microservice. I can test the Resume Builder completely independently of the Job Scraper."

**2. The Router Pattern**
"Don't use massive Switch nodes with regex rules. Put a fast, cheap LLM at the very front of your webhook. Give it your session history, and let it output a structured JSON intent. It makes your n8n workflows feel like magic."

**3. The Judge Pattern**
"At the very end of the Master workflow, before it responds to the user, the payload passes through **The Judge** \u2014 a Gemini Flash node. Its only job is to look for hallucinations or missing data. If it fails, it flags it. Never trust an LLM chain without a deterministic or secondary-LLM quality gate at the end."

---

## Act 4: The Drop (2 mins)

"The best part? You don't need a massive cloud infrastructure to run this.

Everything you just saw is running locally on my laptop right now."

*(Switch to terminal)*

"It's a single `docker-compose.yml` file running n8n and an SQLite database.

I've packaged up the Docker setup and all 5 workflow JSONs. You can scan this QR code, `docker compose up`, drop in your API keys, and have this exact multi-agent system running on your machine tonight.

Thank you."

*(Show QR code / link to GitHub repo)*
