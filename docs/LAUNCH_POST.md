# LinkedIn Launch Post

> Target: under 1300 characters. Builder-to-builder tone. Triplet close.

---

What if job hunting was just a Telegram chat?

You text: "find ML engineer jobs in NYC"
You get: top 5 ranked matches, scored against your resume.

You text: "3"
You get: two PDFs — a tailored resume and cover letter — in 45 seconds. Delivered to your phone. Ready to submit.

That's CareerForge. It's an n8n workflow. One JSON file. ~$2/month to run.

Here's what's under the hood:

The apply pipeline routes through 3 LaTeX skeletons (fresher/experienced/senior), scores your fit with DeepSeek before burning a Sonnet call, and uses Claude to generate structured JSON — not raw LaTeX, because LLMs + LaTeX = chaos. A JS node deterministically fills the skeleton. Deterministic = debuggable.

The outreach and intel branches fan out to up to 3 search providers in parallel, merge results with Reciprocal Rank Fusion (k=60, top 15), then run entity extraction. You configure 1, 2, or 3 providers. It degrades gracefully.

Total cost: $10 one-time deposit → 1000 free model calls/day, forever. Resume + cover = ~$0.10. Monthly bill is basically the cost of a coffee.

It's open source. Runs on Render for free. Railway for $5. Hetzner VPS for $4.59.

[github.com/Career-Forge/n8n]

Build your own. Fork it. Break it. Ship it.

---

*Character count target: ~1100. Adjust hook or technical paragraph to fit LinkedIn's optimal ~1300 char window.*
