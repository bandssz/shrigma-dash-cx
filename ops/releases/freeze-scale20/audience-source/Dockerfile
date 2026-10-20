FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:0759ebf3088f028584ffe5443676a0dc93302e2766db439ac42460c15d13529a
ARG GIT_SHA
ENV CRM_AUDIENCE_REVISION=$GIT_SHA
LABEL org.opencontainers.image.revision="$GIT_SHA"
COPY --chown=node:node segment-audience-native-freeze.cjs segment-audience-native-freeze-api.cjs /app/n8n/growth/
COPY --chown=node:node server.cjs /app/services/crm-audience/
