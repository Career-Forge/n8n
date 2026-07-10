# Superseded resume templates

`master_resume_template.txt` and `master_resume_example.txt` were the source
files for a paste-into-ChatGPT-then-save-a-.txt-file onboarding flow. That
flow is dead -- resume setup is now 100% interactive via Telegram: the bot
sends a JSON schema (from the `Send Resume Template` node), the user fills
it via an LLM of their choice and sends it back as a `.json` file or pasted
text, and `Ingest Resume JSON` parses it deterministically. See
[docs/MASTER_RESUME_GUIDE.md](../../docs/MASTER_RESUME_GUIDE.md) for the
current flow.

Kept for history only. Nothing in the live workflow references either file.
