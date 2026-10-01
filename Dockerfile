# Paperclip Helper: one small Node.js service, no npm dependencies.
FROM node:22-alpine

ARG VERSION=""
ARG REVISION=""
LABEL org.opencontainers.image.title="paperclip-helper" \
      org.opencontainers.image.description="Merge-to-approve relay, stalled-work watchdog and subscription cost sync for self-hosted Paperclip" \
      org.opencontainers.image.source="https://github.com/DevEnterpriseSoftware/paperclip-helper" \
      org.opencontainers.image.url="https://github.com/DevEnterpriseSoftware/paperclip-helper" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    HELPER_VERSION=${VERSION} \
    DATA_DIR=/data

WORKDIR /app
COPY package.json LICENSE ./
COPY src ./src
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 3110

# The service writes a heartbeat to /data/status.json; `health` also checks the relay.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "/app/src/index.mjs", "health"]

ENTRYPOINT ["node", "/app/src/index.mjs"]
