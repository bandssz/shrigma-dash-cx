FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=preview PREVIEW_MODE=synthetic PREVIEW_EXPECT_UID=1000 PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --chown=node:node server.cjs fixtures.cjs ./
COPY --chown=node:node public/ ./public/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD ["node","-e","require('node:http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node","--max-old-space-size=96","server.cjs"]
