FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:692e6e5d6b83d7bc42e87f374c4ffea206daaf8c541e8dbcd18199d05c81f049
ARG GIT_SHA
ENV CRM_CAMPAIGN_REVISION=$GIT_SHA
LABEL org.opencontainers.image.revision="$GIT_SHA"
COPY --chown=node:node source-candidate/n8n/growth/campaign-contract.js source-candidate/n8n/growth/campaign-tracking.js source-candidate/n8n/growth/campaign-service.js source-candidate/n8n/growth/campaign-provider.js /app/n8n/growth/
COPY --chown=node:node source-candidate/services/crm-campaign/transport.cjs source-candidate/services/crm-campaign/editorial-admission.cjs /app/services/crm-campaign/
