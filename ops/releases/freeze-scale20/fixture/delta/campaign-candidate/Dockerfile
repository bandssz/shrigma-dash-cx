FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:6cbdcdc85d2fc58c5f2336a7a9d7237f60093ba09cc7e7fa40cedcd07ba91180
ARG GIT_SHA
ENV CRM_CAMPAIGN_REVISION=$GIT_SHA
LABEL com.shrigma.native-internal-patch-revision="$GIT_SHA" org.opencontainers.image.revision="$GIT_SHA"
COPY --chown=node:node services/crm-campaign/main.cjs /app/services/crm-campaign/main.cjs
COPY --chown=node:node services/crm-campaign/server.cjs /app/services/crm-campaign/server.cjs
COPY --chown=node:node services/crm-campaign/consent-source.cjs /app/services/crm-campaign/consent-source.cjs
COPY --chown=node:node n8n/growth/campaign-provider.js /app/n8n/growth/campaign-provider.js
COPY --chown=node:node n8n/growth/campaign-service.js /app/n8n/growth/campaign-service.js
