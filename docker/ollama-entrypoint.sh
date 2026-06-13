#!/bin/sh
# Start the Ollama server in the background, pull bge-m3 once (idempotent —
# a no-op if already present in the ollama_data volume), then hand the
# server process the foreground so the container stays up.
#
# NOTE: this file must use LF line endings (see ../.gitattributes). With
# CRLF, /bin/sh fails with "bad interpreter".

set -e

ollama serve &
pid=$!

# wait for the API to come up
until ollama list >/dev/null 2>&1; do
  sleep 1
done

echo "[ollama-entrypoint] pulling bge-m3 (first boot only)…"
ollama pull bge-m3 || echo "[ollama-entrypoint] WARN: bge-m3 pull failed; will retry on next boot"

echo "[ollama-entrypoint] ready."
wait "$pid"
