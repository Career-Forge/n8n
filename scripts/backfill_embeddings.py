#!/usr/bin/env python3
"""
backfill_embeddings.py — one-off: embed active jobs missing an embedding.

The ATS poller only embeds jobs on upsert, so jobs cached before bge-m3 was
available have NULL embeddings. This backfills active jobs in batches via the
local Ollama bge-m3 endpoint. Idempotent: re-run until "0 remaining".

Run (from repo root):  python scripts/backfill_embeddings.py
"""
import json
import subprocess
import urllib.request

OLLAMA = "http://localhost:11434/api/embed"
BATCH = 16
PSQL = ["docker", "compose", "exec", "-T", "postgres",
        "psql", "-U", "careerforge", "-d", "careerforge"]


def psql(sql, capture=True):
    # pipe SQL via stdin (avoids Windows command-line length limit for big vectors)
    r = subprocess.run(PSQL + (["-t", "-A", "-F", "\x1f"] if capture else []),
                       input=sql, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", cwd="docker")
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout


def embed(texts):
    body = json.dumps({"model": "bge-m3", "input": texts}).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.load(resp)["embeddings"]


def main():
    total = 0
    while True:
        rows = psql(
            "SELECT id, left(coalesce(title,'') || ' ' || coalesce(jd_text,''), 2000) "
            "FROM jobs WHERE status='active' AND embedding IS NULL ORDER BY id LIMIT %d" % BATCH
        ).strip()
        if not rows:
            break
        pairs = [r.split("\x1f", 1) for r in rows.splitlines() if r.strip()]
        ids = [p[0] for p in pairs]
        texts = [(p[1] if len(p) > 1 else "").replace("\n", " ")[:2000] or "job" for p in pairs]
        embs = embed(texts)
        # build a single UPDATE ... FROM (VALUES ...) batch
        values = ",".join(
            "(%s, '[%s]'::vector)" % (ids[i], ",".join(str(x) for x in embs[i]))
            for i in range(len(ids))
        )
        psql("UPDATE jobs j SET embedding = v.emb FROM (VALUES %s) AS v(id, emb) "
             "WHERE j.id = v.id" % values, capture=False)
        total += len(ids)
        print("embedded %d (running total %d)" % (len(ids), total), flush=True)
    remaining = psql("SELECT count(*) FROM jobs WHERE status='active' AND embedding IS NULL").strip()
    print("DONE. backfilled %d; remaining active-without-embedding: %s" % (total, remaining))


if __name__ == "__main__":
    main()
