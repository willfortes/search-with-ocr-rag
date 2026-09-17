# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY docs ./docs

RUN mkdir -p /app/downloads

ENV NODE_ENV=production
ENV PORT=3847
ENV MEILI_HOST=http://meilisearch:7700
ENV MEILI_MASTER_KEY=dev_master_key_change_me
ENV MEILI_INDEX=product_images
ENV OLLAMA_URL=http://host.docker.internal:11434
ENV OLLAMA_MODEL=qwen2.5:3b

EXPOSE 3847

VOLUME ["/app/downloads"]

CMD ["node", "server/index.js"]
