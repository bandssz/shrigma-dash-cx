FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:88230dabe12aa6d052f3df7418895a51eb992b58092d91ca7e0aa600a9db72ad
# Preserve the actual installed main, server, editorial admission and consent.
# Composition is OFF; this preparation does not enable a production route.
COPY --chown=node:node services/crm-campaign/native-read.cjs services/crm-campaign/native-read-transport.cjs services/crm-campaign/native-executor.cjs services/crm-campaign/native-history.cjs services/crm-campaign/native-catalog.cjs /app/services/crm-campaign/
