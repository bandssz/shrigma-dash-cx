FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG GIT_SHA
LABEL org.opencontainers.image.source="https://github.com/bandssz/shrigma-dash-cx" \
      org.opencontainers.image.revision="${GIT_SHA}"
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app/services/crm-audience-sandbox
COPY services/crm-audience-sandbox/package.json services/crm-audience-sandbox/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY services/crm-audience-sandbox/*.cjs ./
COPY services/crm-audience/server.cjs /app/services/crm-audience/server.cjs
COPY services/dashboard-operational/fixtures.cjs /app/services/dashboard-operational/fixtures.cjs
COPY tests/segment-audience-store-fixture.cjs /app/tests/segment-audience-store-fixture.cjs
COPY tests/fixtures/journey-graph-auth.sql /app/tests/fixtures/journey-graph-auth.sql
COPY n8n/access/panel-short-keys.sql /app/n8n/access/panel-short-keys.sql
COPY n8n/growth/campaign-provider.sql n8n/growth/segment-audience-store.sql /app/n8n/growth/
COPY n8n/growth/segment-audience-store.cjs n8n/growth/segment-audience-api.cjs n8n/growth/segment-audience-review.cjs n8n/growth/segment-audience-contract.js n8n/growth/segment-shopify-facts.cjs n8n/growth/segment-shopify-rfm.cjs n8n/growth/segment-recorded-origin.cjs /app/n8n/growth/
RUN mkdir -m 0700 /sandbox-data && chown node:node /sandbox-data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "main.cjs"]
