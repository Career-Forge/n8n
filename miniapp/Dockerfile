# ── Stage 1: build the frontend ────────────────────────────────
FROM node:22-alpine AS webbuild
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

# ── Stage 2: FastAPI runtime + built static assets ──────────────
FROM python:3.12-slim
WORKDIR /app

COPY api/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY api/app ./app
COPY --from=webbuild /web/dist ./app/static

EXPOSE 5681
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "5681"]
