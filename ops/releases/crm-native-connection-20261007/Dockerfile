FROM ghcr.io/bandssz/shrigma-dash-crm-presentation-v2@sha256:1adba1fb8a222684b300ed49fbb2f0adf681bd24ab679022eb15c765328f4911 AS native-build
USER 0:0
WORKDIR /source
ARG GIT_SHA
COPY services/dashboard-operational/auth.cjs services/dashboard-operational/server.cjs services/dashboard-operational/proxy.cjs services/dashboard-operational/crm-master-audience-read.cjs services/dashboard-operational/crm-master-audience-count.cjs services/dashboard-operational/segment-audience-context-review.cjs services/dashboard-operational/segment-audience-review.cjs services/dashboard-operational/crm-native-delegation.cjs services/dashboard-operational/crm-native-mcp.cjs services/dashboard-operational/crm-native-operator.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-source-sync.cjs services/dashboard-operational/native-source-operator.cjs services/dashboard-operational/native-source-transport.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-source-diagnostics.cjs services/dashboard-operational/native-source-diagnostics-controller.cjs services/dashboard-operational/native-source-diagnostics-ui.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-database-vault.cjs services/dashboard-operational/native-database-operator.cjs services/dashboard-operational/native-database-inventory.cjs services/dashboard-operational/native-pg-driver.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/crm-published-journey-read.cjs services/dashboard-operational/crm-master-template-read.cjs services/dashboard-operational/crm-individual-coexistence.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-foundation-preview.cjs services/dashboard-operational/crm-journey-read.cjs services/dashboard-operational/build.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/journey-read/growth-flows.js ./services/dashboard-operational/journey-read/
COPY services/dashboard-operational/public/entry.js ./services/dashboard-operational/public/
COPY growth.html ./
COPY assets/panels/growth.js ./assets/panels/
COPY services/dashboard-operational/crm-presentation.css ./services/dashboard-operational/
COPY services/dashboard-operational/own-foundation/ ./services/dashboard-operational/own-foundation/
COPY tools/native-pg-dependency/package.json tools/native-pg-dependency/package-lock.json tools/native-pg-dependency/build-driver.cjs ./tools/native-pg-dependency/
RUN cd tools/native-pg-dependency && npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org
COPY services/dashboard-operational/native-continuity/read-only.cjs services/dashboard-operational/native-continuity/pins.json ./services/dashboard-operational/native-continuity/
COPY ops/releases/crm-native-connection-20261007/bootstrap.cjs ops/releases/crm-native-connection-20261007/build-release.cjs ops/releases/crm-native-connection-20261007/build-journey-presentation.cjs ops/releases/crm-native-connection-20261007/start-existing.cjs ops/releases/crm-native-connection-20261007/health-existing.cjs ./ops/releases/crm-native-connection-20261007/
RUN node ops/releases/crm-native-connection-20261007/build-release.cjs /source /app /native-output "$GIT_SHA"

FROM ghcr.io/bandssz/shrigma-dash-crm-presentation-v2@sha256:1adba1fb8a222684b300ed49fbb2f0adf681bd24ab679022eb15c765328f4911 AS runtime
ARG GIT_SHA
LABEL org.opencontainers.image.title="Shrigma native CRM connection" \
      org.opencontainers.image.source="https://github.com/bandssz/shrigma-dash-cx" \
      org.opencontainers.image.revision="$GIT_SHA" \
      shrigma.native.parent="sha256:1adba1fb8a222684b300ed49fbb2f0adf681bd24ab679022eb15c765328f4911"
USER 0:0
COPY --from=native-build /native-output/ /app/native-backend/
COPY --from=native-build /native-output-presentation/ /app/presentation-release/
COPY --from=native-build /native-output-pg-driver/ /app/native-pg-driver/
RUN chmod 0555 /app/native-backend /app/native-backend/runtime /app/native-backend/runtime/native-continuity /app/native-backend/runtime/own-foundation /app/native-backend/runtime/journey-read /app/native-pg-driver /app/presentation-release /app/presentation-release/public /app/presentation-release/public/assets /app/presentation-release/public/assets/panels
USER 1000:1000
# Native startup is admitted separately by Root on the existing Compose gateway.
# The historical pack/controller and public V2 files stay intact. Production uses
# the fresh immutable start-existing entrypoint, never the inherited old CMD.
