FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:6cbdcdc85d2fc58c5f2336a7a9d7237f60093ba09cc7e7fa40cedcd07ba91180
ARG GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA
ENV CRM_CAMPAIGN_REVISION=$GIT_SHA
USER 0:0
COPY n8n/growth/campaign-contract.js /app/n8n/growth/campaign-contract.js
COPY n8n/growth/campaign-provider.js /app/n8n/growth/campaign-provider.js
COPY n8n/growth/campaign-runtime.js /app/n8n/growth/campaign-runtime.js
COPY n8n/growth/campaign-service.js /app/n8n/growth/campaign-service.js
COPY services/crm-campaign/transport.cjs /app/services/crm-campaign/transport.cjs
USER 1000:1000
