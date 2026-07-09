# Applied patch scripts (historical)

One-shot patch scripts that have already been run against the live workflow
and committed. Kept for history and as reference implementations of the
patch-script conventions (string-anchored replaces, inline harness before
any write).

DO NOT RE-RUN these -- several would reintroduce bugs that later scripts
fixed (their anchors target old node states and most will fail loudly on
the integrity checks, but do not rely on that).

Living tools stay in scripts/: export_prompts.js (drift checker + mirror
generator), backfill_embeddings.py, import_registry.js, uptime_ping.sh,
resume_template.json, and any s-script that has not yet been deployed.
