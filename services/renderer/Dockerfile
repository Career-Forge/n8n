# CareerForge renderer -- headless Chromium liveness lane (Tier 3).
# Use the python base + `playwright install --with-deps chromium` so the browser
# always matches the installed playwright version (no image-tag drift to track).
FROM python:3.12-slim

WORKDIR /app
ENV PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1

RUN pip install --no-cache-dir fastapi "uvicorn[standard]" playwright httpx \
    && playwright install --with-deps chromium

COPY app.py .

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
