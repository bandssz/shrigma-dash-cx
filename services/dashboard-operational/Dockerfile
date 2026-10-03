FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS package
WORKDIR /source

# Only this public revision argument exists. No secret is a build argument.
ARG GIT_SHA
COPY growth.html organico.html influs.html ./
COPY growth-diagnostico.html growth-control.js growth-delivery.js growth-diagnostic.js growth-diagnostic-ui.js ./
COPY assets/panels/growth.js assets/panels/growth.css assets/panels/organico.js assets/panels/organico.css assets/panels/influs.js assets/panels/influs.css ./assets/panels/
COPY logos/icone-aristocrata.png logos/icone-fishermans.svg logos/icone-olivas.jpg logos/wm-aristocrata.png logos/wm-fishermans.png logos/wm-olivas.png ./logos/
COPY services/dashboard-operational/build.cjs services/dashboard-operational/pack-runtime.cjs services/dashboard-operational/artifact-policy.cjs services/dashboard-operational/bootstrap.cjs services/dashboard-operational/server.cjs services/dashboard-operational/auth.cjs services/dashboard-operational/crm-manager-journal.cjs services/dashboard-operational/proxy.cjs services/dashboard-operational/backend-credential-attestation.cjs services/dashboard-operational/fixtures.cjs services/dashboard-operational/segment-audience-contract.js services/dashboard-operational/canary-start.cjs services/dashboard-operational/canary-image.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/public/entry.html services/dashboard-operational/public/entry.js services/dashboard-operational/public/entry.css services/dashboard-operational/public/guard.js services/dashboard-operational/public/media-read.js ./services/dashboard-operational/public/
RUN node services/dashboard-operational/build.cjs /artifact-build \
 && node services/dashboard-operational/pack-runtime.cjs /artifact-build /artifact-pack \
 && node services/dashboard-operational/canary-image.cjs /artifact-pack "$GIT_SHA" /image

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
ARG GIT_SHA
LABEL org.opencontainers.image.title="Shrigma dashboard canary" \
      org.opencontainers.image.source="https://github.com/bandssz/shrigma-dash-cx" \
      org.opencontainers.image.revision="$GIT_SHA"
WORKDIR /app
COPY --from=package --chmod=0444 /image/runtime-pack.json /image/bootstrap.cjs /image/artifact-policy.cjs /image/canary-start.cjs /image/canary-image.cjs /image/image-pin.json ./
RUN mkdir /dashboard-data && chown 1000:1000 /dashboard-data && chmod 0700 /dashboard-data
ENV NODE_ENV=production \
    DASHBOARD_MODE=synthetic \
    DASHBOARD_UPSTREAMS={} \
    DASHBOARD_UPSTREAM_HOSTS=[] \
    HOST=0.0.0.0 \
    PORT=8080
USER 1000:1000
VOLUME ["/dashboard-data"]
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "--max-old-space-size=128", "/app/canary-start.cjs"]
