# LinkedIn Launch Post

> Target: under 1300 characters. Builder-to-builder tone. Triplet close.

---

What if job hunting was just a Telegram chat -- with a real app behind it when you want one?

You text: "find ML engineer jobs in NYC"
You get: top 5 ranked matches, scored against your resume.

You text: "3"
You get: two PDFs -- a tailored resume and cover letter -- in about 5 minutes. Delivered to your phone. Ready to submit.

That's CareerForge. Self-hosted, chat-first, ~$2/month to run.

Here's what's under the hood:

The apply pipeline scores your fit with DeepSeek before burning a Sonnet call, then has Claude generate structured JSON -- not raw LaTeX, because LLMs + LaTeX = chaos. A JS node deterministically fills a shared, tier-aware skeleton. Deterministic = debuggable.

There is also a Telegram Mini App now -- FastAPI + React, HMAC-validated auth -- for anyone who wants a real UI instead of text: a job table with match scores, a kanban tracker, your resume ForgeScore. Actions replay through the same bot pipeline -- no second copy of logic to keep in sync.

Total cost: $10 one-time deposit → 1000 free model calls/day, forever. Resume + cover = ~$0.10/apply.

It's open source. Runs on Render for free. Railway for $5. Hetzner VPS for $4.59.

[github.com/Career-Forge/n8n]

Build your own. Fork it. Break it. Ship it.

---

*Character count: ~1240 (target under 1300).*
