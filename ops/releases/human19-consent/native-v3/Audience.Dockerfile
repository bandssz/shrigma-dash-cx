FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:696f615f25acbc1c8a8398771e2f86654951092fe9f8c383341fc6d7fcf9905e
ARG GIT_SHA
ENV CRM_AUDIENCE_REVISION=$GIT_SHA
LABEL org.opencontainers.image.revision="$GIT_SHA" com.shrigma.native-freeze-v3-revision="$GIT_SHA"
COPY --chown=node:node audience-freeze.cjs /app/n8n/growth/segment-audience-native-freeze.cjs
