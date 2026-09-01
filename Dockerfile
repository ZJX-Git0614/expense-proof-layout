FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY index.html styles.css app.js server.py ./
RUN pip install --no-cache-dir Pillow

ENV PORT=4173
EXPOSE 4173
CMD ["python", "server.py"]
