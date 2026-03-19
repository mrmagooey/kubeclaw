FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    chromium chromium-sandbox \
    fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
    libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libasound2 libpangocairo-1.0-0 libcups2 libdrm2 libxshmfence1 \
    curl && rm -rf /var/lib/apt/lists/*

# Non-root user required for --no-sandbox
RUN useradd -m chrome
USER chrome

EXPOSE 9222

HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD curl -sf http://localhost:9222/json/version || exit 1

ENTRYPOINT ["chromium", \
  "--headless=new", \
  "--remote-debugging-address=0.0.0.0", \
  "--remote-debugging-port=9222", \
  "--no-sandbox", \
  "--disable-setuid-sandbox", \
  "--disable-dev-shm-usage", \
  "--user-data-dir=/tmp/chrome-data"]
