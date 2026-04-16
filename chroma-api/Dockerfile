FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 5680

CMD ["gunicorn", "--bind", "0.0.0.0:5680", "--timeout", "120", "--workers", "2", "app:app"]
