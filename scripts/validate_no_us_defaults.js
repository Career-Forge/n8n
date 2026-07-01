#!/usr/bin/env node
/**
 * P4b guard: fail if any tracked US-first defaults or weak credentials have
 * drifted back into the codebase.
 *
 * Checks:
 *   - ${TIMEZONE:-America/New_York}  -- docker compose hardcode
 *   - prefs.timezone || "America/New_York"  -- Schedule Gate fallback
 *   - tz || "America/New_York"              -- renderSchedule fallback
 *   - N8N_PASSWORD:-demo1234               -- weak credential default
 *
 * Usage: node scripts/validate_no_us_defaults.js
 * Exit 0 = clean, exit 1 = violations found.
 */

const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const TARGETS = [
  // docker infra
  "docker/docker-compose.yml",
  "docker/docker-compose.render.yml",
  "docker/render.yaml",
  "docker/.env.example",
  // workflow exports
  "docker/workflows/CareerForge_Master_local.json",
  "workflows/CareerForge_Master_local.json",
  "docker/workflows/CareerForge Master Local v6.3.json",
];

const PATTERNS = [
  { re: /TIMEZONE:-America\/New_York/,         label: "TIMEZONE default = America/New_York in compose/yaml" },
  { re: /prefs\.timezone\s*\|\|\s*["']America\/New_York["']/, label: "prefs.timezone fallback = America/New_York in workflow JS" },
  { re: /\btz\s*\|\|\s*["']America\/New_York["']/, label: "tz fallback = America/New_York in workflow JS" },
  { re: /N8N_PASSWORD:-demo1234/,              label: "weak N8N_PASSWORD default (demo1234) in compose" },
  // catch raw YAML literal that render.yaml might carry
  { re: /value:\s*America\/New_York/,          label: "literal America/New_York value in render.yaml" },
];

let violations = 0;

for (const rel of TARGETS) {
  const fp = path.join(ROOT, rel);
  if (!fs.existsSync(fp)) {
    console.warn(`  SKIP  ${rel}  (file not found)`);
    continue;
  }
  const content = fs.readFileSync(fp, "utf8");
  for (const { re, label } of PATTERNS) {
    const m = content.match(re);
    if (m) {
      console.error(`  FAIL  ${rel}`);
      console.error(`        ${label}`);
      console.error(`        matched: ${JSON.stringify(m[0])}`);
      violations++;
    }
  }
}

if (violations === 0) {
  console.log("  PASS  validate_no_us_defaults -- no tracked US-first defaults or weak credentials found");
  process.exit(0);
} else {
  console.error(`\n  ${violations} violation(s) found. Fix before committing.`);
  process.exit(1);
}
