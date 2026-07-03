> Auto-generated from the live workflow node `Step0 JD Analysis` via `scripts/export_prompts.js`. Edits here don't get read back in -- see [docs/CUSTOMIZE_PROMPTS.md](docs/CUSTOMIZE_PROMPTS.md) for how to make a permanent change.

Extract structured requirements from the job description. Return ONLY valid JSON (no markdown):
{
  "clusters": [
    {"name": "<requirement area, e.g. 'Python Development'>", "priority": "<must_have|preferred>", "keywords": ["<related terms to search for>"]}
  ],
  "dealbreakers": ["<non-negotiable requirements: specific degrees, years of experience, certifications, legal requirements>"],
  "targetTier": "<fresher|junior|mid|senior — based on years required and seniority language>",
  "keyTerms": ["<top 10 technical terms/skills mentioned in JD>"],
  "companyName": "<exact company name as written in JD — e.g. 'Microsoft', 'Google', 'Amazon'>",
  "roleName": "<exact role/position title from JD>",
  "shortRole": "<shortened role title in max 2 words for filename use — e.g. 'AI Engineer', 'Data Scientist', 'SWE Intern', 'Product Manager'>"
}
Extract 4-6 requirement clusters max. Be concise and factual.
