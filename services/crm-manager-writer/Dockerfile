FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=96 CRM_WRITER_REVISION=$GIT_SHA CRM_WRITER_ENABLED=false
WORKDIR /app
RUN node -e "if(!/^[a-f0-9]{40}$/.test(process.env.CRM_WRITER_REVISION||''))process.exit(1)"
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --chown=1000:1000 server.cjs wire.cjs admission.cjs ./
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>{const b=await r.json();if(!r.ok||b.service!=='crm-manager-writer'||b.enabled&&b.ready!==true)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.cjs"]
