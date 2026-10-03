# Listener somente leitura de templates (crm-template-read-v1). Nasce OFF.
# Contexto de build: raiz do repositório. Nenhum segredo na imagem.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ENV NODE_ENV=production
WORKDIR /app/services/crm-template-read
COPY services/crm-template-read/package.json services/crm-template-read/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node services/crm-template-read/*.cjs ./
# Mesma validação de resposta da ponte do portal (contrato único).
COPY --chown=node:node services/dashboard-operational/crm-template-read-bridge.cjs /app/services/dashboard-operational/
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "main.cjs"]
