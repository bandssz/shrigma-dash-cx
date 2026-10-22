FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:eeacec2eb62218bba72de2e7a70c290d57e8e387ed668e4e126b0a4b52427f26
ARG GIT_SHA
ENV CRM_CAMPAIGN_REVISION=$GIT_SHA
LABEL org.opencontainers.image.revision="$GIT_SHA"
COPY --chown=node:node consent-source.cjs server.cjs /app/services/crm-campaign/
