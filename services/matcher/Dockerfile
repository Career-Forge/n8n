# CareerForge matcher service — cross-encoder rerank + skill graph (Sprint 4).
# CPU torch keeps the image lean and avoids GPU-passthrough assumptions; flip to
# GPU later by basing on a CUDA image and setting MATCHER_DEVICE=cuda.
FROM python:3.11-slim

WORKDIR /app

# CPU-only torch (much smaller than the CUDA wheels)
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the cross-encoder into the image so the first /match isn't a ~1GB surprise.
ENV HF_HOME=/app/.hf
RUN python -c "from sentence_transformers import CrossEncoder; CrossEncoder('BAAI/bge-reranker-v2-m3', max_length=512)"

# Ingestion deps (Phase 1) — installed AFTER the bake so the ~2GB model layer
# stays cached when this list changes.
RUN pip install --no-cache-dir "psycopg[binary]>=3.1"

COPY . .

EXPOSE 5680
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5680"]
