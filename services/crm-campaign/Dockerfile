FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ENV NODE_ENV=production
WORKDIR /app
COPY services/crm-campaign/package.json services/crm-campaign/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node services/crm-campaign/*.cjs ./services/crm-campaign/
COPY --chown=node:node services/crm-panel-read/server.cjs ./services/crm-panel-read/server.cjs
COPY --chown=node:node n8n/growth/campaign-contract.js n8n/growth/campaign-tracking.js n8n/growth/campaign-service.js n8n/growth/campaign-store.js n8n/growth/campaign-provider.js n8n/growth/campaign-native.js n8n/growth/campaign-runtime.js ./n8n/growth/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "services/crm-campaign/main.cjs"]
