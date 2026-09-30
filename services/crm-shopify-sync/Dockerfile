FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=256
WORKDIR /app
COPY services/crm-shopify-sync/package.json services/crm-shopify-sync/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node services/crm-shopify-sync/*.cjs ./services/crm-shopify-sync/
COPY --chown=node:node n8n/growth/segment-shopify-bulk-evidence.cjs n8n/growth/segment-shopify-product-evidence.cjs n8n/growth/segment-shopify-customer-products-bulk.graphql n8n/growth/segment-shopify-bulk-state.graphql ./n8n/growth/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","services/crm-shopify-sync/main.cjs"]
