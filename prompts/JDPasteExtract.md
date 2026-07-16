> Auto-generated from the live workflow node `JD Paste Extract` via `scripts/export_prompts.js`. Edits here don't get read back in -- see [docs/CUSTOMIZE_PROMPTS.md](docs/CUSTOMIZE_PROMPTS.md) for how to make a permanent change.

Extract structured info from this pasted job description. Return ONLY valid JSON (no markdown):
{
  "companyName": "<exact company name as written in the JD -- if not stated anywhere, use 'the company'>",
  "roleName": "<exact role/position title from the JD -- if not stated, use 'this role'>",
  "shortRole": "<shortened role title in max 2 words for filename use -- e.g. 'AI Engineer', 'Data Scientist'>"
}
Be concise and factual. Do not invent a company or role name that is not actually present in the text.
