FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:da9225ca0674b6f20a50f179f2501b05d73f30995fb74d95fb6368bd792d1103
ARG GIT_SHA
LABEL com.shrigma.native-internal-patch-revision="$GIT_SHA" org.opencontainers.image.revision="$GIT_SHA"
COPY --chown=node:node n8n/growth/campaign-provider.js /app/n8n/growth/campaign-provider.js
COPY --chown=node:node n8n/growth/campaign-runtime.js /app/n8n/growth/campaign-runtime.js
COPY --chown=node:node n8n/growth/campaign-service.js /app/n8n/growth/campaign-service.js
COPY --chown=node:node n8n/growth/campaign-native-internal.js /app/n8n/growth/campaign-native-internal.js
COPY --chown=node:node services/crm-campaign/main.cjs /app/services/crm-campaign/main.cjs
COPY --chown=node:node services/crm-campaign/server.cjs /app/services/crm-campaign/server.cjs
COPY --chown=node:node services/crm-campaign/transport.cjs /app/services/crm-campaign/transport.cjs
