FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:bbc59df42fa4f115e517b56cd2cd549b2fed247ccf9344bf4dac2326c0c18032
ARG GIT_SHA
ENV CRM_CAMPAIGN_REVISION=$GIT_SHA
LABEL org.opencontainers.image.revision="$GIT_SHA"
COPY --chown=node:node campaign-contract.js /app/n8n/growth/campaign-contract.js
COPY --chown=node:node campaign-tracking.js /app/n8n/growth/campaign-tracking.js
COPY --chown=node:node campaign-service.js /app/n8n/growth/campaign-service.js
