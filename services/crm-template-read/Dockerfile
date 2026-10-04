# Listener somente leitura de templates (crm-template-read-v1). Nasce OFF.
# Contexto de build: raiz do repositório. Nenhum segredo na imagem.
# Build reproduzível com revisão exata (obrigatória, SHA Git completo):
#   docker build --build-arg CRM_TEMPLATE_READ_REVISION=<40 hex> \
#     -f services/crm-template-read/Dockerfile -t <imagem> .
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG CRM_TEMPLATE_READ_REVISION
RUN case "$CRM_TEMPLATE_READ_REVISION" in \
      *[!0-9a-f]*|"") echo "CRM_TEMPLATE_READ_REVISION deve ser SHA Git completo" >&2; exit 1;; \
    esac; \
    [ "${#CRM_TEMPLATE_READ_REVISION}" -eq 40 ] || { echo "CRM_TEMPLATE_READ_REVISION deve ter 40 hex" >&2; exit 1; }
LABEL org.opencontainers.image.title="crm-template-read" \
      org.opencontainers.image.description="Leitura de templates por marca (crm-template-read-v1), OFF por padrão" \
      org.opencontainers.image.source="https://github.com/bandssz/shrigma-dash-cx" \
      org.opencontainers.image.revision="${CRM_TEMPLATE_READ_REVISION}"
# Padrão funcional sem nenhuma variável externa: OFF, sem pool, sem driver, sem segredo.
ENV NODE_ENV=production \
    CRM_TEMPLATE_READ_REVISION=${CRM_TEMPLATE_READ_REVISION} \
    CRM_TEMPLATE_READ_ENABLED=false
WORKDIR /app/services/crm-template-read
COPY services/crm-template-read/package.json services/crm-template-read/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node services/crm-template-read/config.cjs services/crm-template-read/store.cjs services/crm-template-read/server.cjs services/crm-template-read/main.cjs ./
# Mesma validação de resposta da ponte do portal (contrato único).
COPY --chown=node:node services/dashboard-operational/crm-template-read-bridge.cjs /app/services/dashboard-operational/crm-template-read-bridge.cjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "main.cjs"]
