# Build from repo root:
#   docker build -f tools/openmoq-recorder/Dockerfile -t openmoq-recorder:latest .
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl openssl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/tools/openmoq-recorder

# COPY package.json and dist/ separately — a combined COPY flattens dist/* into the
# package root, breaking exports that expect ./dist/index.js.
COPY web/frontend/vendor/moq-playa/packages/msf/package.json \
     /app/web/frontend/vendor/moq-playa/packages/msf/
COPY web/frontend/vendor/moq-playa/packages/msf/dist \
     /app/web/frontend/vendor/moq-playa/packages/msf/dist
COPY web/frontend/vendor/moq-playa/packages/transport/package.json \
     /app/web/frontend/vendor/moq-playa/packages/transport/
COPY web/frontend/vendor/moq-playa/packages/transport/dist \
     /app/web/frontend/vendor/moq-playa/packages/transport/dist
COPY web/frontend/vendor/moq-playa/packages/webtransport/package.json \
     /app/web/frontend/vendor/moq-playa/packages/webtransport/
COPY web/frontend/vendor/moq-playa/packages/webtransport/dist \
     /app/web/frontend/vendor/moq-playa/packages/webtransport/dist

COPY tools/openmoq-recorder/package.json \
     tools/openmoq-recorder/record.mjs \
     tools/openmoq-recorder/cert.mjs \
     tools/openmoq-recorder/wt-adapter.mjs \
     tools/openmoq-recorder/openmoq-init.mjs \
     ./

# Vendor packages use file: links (@moqt/webtransport -> ../transport, msf -> fast-json-patch).
# npm install must run in each package tree before the recorder install.
RUN cd /app/web/frontend/vendor/moq-playa/packages/msf && npm install --omit=dev \
    && cd /app/web/frontend/vendor/moq-playa/packages/webtransport && npm install --omit=dev \
    && cd /app/tools/openmoq-recorder && npm install --omit=dev \
    && node record.mjs --probe

ENTRYPOINT ["node", "/app/tools/openmoq-recorder/record.mjs"]
