FROM ghcr.io/bandssz/shrigma-dash-crm-presentation-v2@sha256:1adba1fb8a222684b300ed49fbb2f0adf681bd24ab679022eb15c765328f4911 AS native-build
USER 0:0
WORKDIR /source
ARG GIT_SHA
COPY services/dashboard-operational/product-issues.cjs services/dashboard-operational/product-issues-ui.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/campaign-editorial-policy.cjs services/dashboard-operational/crm-campaign-editorial-admission.cjs services/dashboard-operational/crm-payload-shape.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/crm-ui-features.cjs services/dashboard-operational/shopify-paid-order.cjs services/dashboard-operational/crm-paid-facts.cjs services/dashboard-operational/crm-paid-facts-store.cjs services/dashboard-operational/crm-paid-facts-ui.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/crm-paid-home-layout-ui.cjs services/dashboard-operational/crm-paid-home-ui.cjs services/dashboard-operational/crm-paid-comparison-ui.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/crm-paid-results.cjs services/dashboard-operational/crm-paid-results-ui.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/crm-paid-acquisition.cjs services/dashboard-operational/crm-paid-acquisition-service.cjs services/dashboard-operational/crm-paid-acquisition-backup.cjs services/dashboard-operational/crm-paid-acquisition-ui.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/campaign-consent-observation.cjs services/dashboard-operational/campaign-consent-observation-route.cjs services/dashboard-operational/campaign-consent-observation-ui.cjs services/dashboard-operational/campaign-consent-task.cjs services/dashboard-operational/campaign-consent-store.cjs services/dashboard-operational/campaign-consent-broker.cjs services/dashboard-operational/campaign-consent-service-binding.cjs services/dashboard-operational/campaign-consent-policy.json ./services/dashboard-operational/
COPY services/dashboard-operational/simple-crm-native-internal.cjs services/dashboard-operational/native-internal-release.json ./services/dashboard-operational/
COPY services/dashboard-operational/campaign-write-contract.js services/dashboard-operational/campaign-write-tracking.js ./services/dashboard-operational/
COPY services/dashboard-operational/journey-internal-test-runtime.cjs services/dashboard-operational/journey-internal-test-transport.cjs services/dashboard-operational/journey-internal-test-binding.cjs services/dashboard-operational/journey-internal-html-binding.cjs services/dashboard-operational/journey-internal-html-snapshot.cjs services/dashboard-operational/journey-send-window.cjs services/dashboard-operational/journey-activation-review.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/simple-tts-manual.cjs services/dashboard-operational/influs-tts-manual.js ./services/dashboard-operational/
COPY services/dashboard-operational/simple-crm-model-pieces.cjs services/dashboard-operational/model-piece-input.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/simple-login-accounts.cjs services/dashboard-operational/simple-dashboard-read.cjs services/dashboard-operational/simple-crm-models.cjs services/dashboard-operational/simple-crm-model-tests.cjs services/dashboard-operational/simple-crm-campaign-tests.cjs services/dashboard-operational/simple-crm-campaign-audiences.cjs services/dashboard-operational/private-test-diagnostics.cjs services/dashboard-operational/bcrypt.mjs services/dashboard-operational/BCRYPT-LICENSE ./services/dashboard-operational/
COPY services/dashboard-operational/public/afiliados-preview/ ./services/dashboard-operational/public/afiliados-preview/
COPY services/dashboard-operational/public/read-workspace.js ./services/dashboard-operational/public/
COPY services/dashboard-operational/public/influs-workspace/ ./services/dashboard-operational/public/influs-workspace/
COPY services/dashboard-operational/public/organico-workspace/index.html services/dashboard-operational/public/organico-workspace/app.js services/dashboard-operational/public/organico-workspace/organico-attribution.js ./services/dashboard-operational/public/organico-workspace/
COPY services/dashboard-operational/public/crm-preview/ /source/services/dashboard-operational/public/crm-preview/
COPY services/dashboard-operational/public/entry.html services/dashboard-operational/public/entry.css ./services/dashboard-operational/public/
COPY services/dashboard-operational/dashboard-individual-read.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/afiliados-read.cjs services/dashboard-operational/afiliados-read-contract.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/afiliados-native-consent.cjs services/dashboard-operational/afiliados-source-operator.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/public/afiliados-session-read.cjs services/dashboard-operational/public/guard.compiled.js ./services/dashboard-operational/public/
COPY services/dashboard-operational/auth.cjs services/dashboard-operational/server.cjs services/dashboard-operational/proxy.cjs services/dashboard-operational/crm-manager-runtime.cjs services/dashboard-operational/crm-campaign-create.cjs services/dashboard-operational/crm-campaign-delivery.cjs services/dashboard-operational/crm-master-audience-read.cjs services/dashboard-operational/crm-master-audience-count.cjs services/dashboard-operational/audience-last-count.cjs services/dashboard-operational/segment-audience-context-review.cjs services/dashboard-operational/segment-audience-review.cjs services/dashboard-operational/crm-native-delegation.cjs services/dashboard-operational/crm-native-mcp.cjs services/dashboard-operational/crm-native-operator.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-source-sync.cjs services/dashboard-operational/native-source-operator.cjs services/dashboard-operational/native-source-transport.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-delivery-health.cjs services/dashboard-operational/native-delivery-health-controller.cjs services/dashboard-operational/native-delivery-health-operator.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-scheduler-api-profile.cjs services/dashboard-operational/native-scheduler-binding.cjs services/dashboard-operational/native-scheduler-binding-operator.cjs services/dashboard-operational/native-scheduler-diagnostic-transport.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-scheduler-state.cjs services/dashboard-operational/native-scheduler-state-consent.cjs services/dashboard-operational/native-scheduler-state-controller.cjs services/dashboard-operational/native-scheduler-state-operator.cjs services/dashboard-operational/native-scheduler-state-chat-approval.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-source-diagnostics.cjs services/dashboard-operational/native-source-diagnostics-controller.cjs services/dashboard-operational/native-source-diagnostics-ui.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-database-vault.cjs services/dashboard-operational/native-database-operator.cjs services/dashboard-operational/native-database-inventory.cjs services/dashboard-operational/native-health-view-structure.cjs services/dashboard-operational/native-pg-driver.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/crm-published-journey-read.cjs services/dashboard-operational/crm-master-template-read.cjs services/dashboard-operational/crm-individual-coexistence.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/native-foundation-preview.cjs services/dashboard-operational/crm-journey-read.cjs services/dashboard-operational/build.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/journey-read/growth-flows.js ./services/dashboard-operational/journey-read/
COPY services/dashboard-operational/public/entry.js services/dashboard-operational/public/entry.compiled.js ./services/dashboard-operational/public/
COPY services/dashboard-operational/campaign-ui-assets.json ./services/dashboard-operational/
COPY growth.html influs.html organico.html ./
COPY assets/panels/growth.js assets/panels/influs.js assets/panels/growth.css assets/panels/organico.css assets/panels/influs.css ./assets/panels/
COPY services/dashboard-operational/crm-presentation.css services/dashboard-operational/organico-presentation.css services/dashboard-operational/influs-presentation.css ./services/dashboard-operational/
COPY services/dashboard-operational/own-foundation/ ./services/dashboard-operational/own-foundation/
COPY tools/native-pg-dependency/package.json tools/native-pg-dependency/package-lock.json tools/native-pg-dependency/build-driver.cjs ./tools/native-pg-dependency/
RUN cd tools/native-pg-dependency && npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org
COPY tools/prepared-worker/build.cjs tools/prepared-worker/command.cjs tools/prepared-worker/queue.sql ./tools/prepared-worker/
COPY ops/releases/crm-native-connection-20261007/bootstrap.cjs ops/releases/crm-native-connection-20261007/build-release.cjs ops/releases/crm-native-connection-20261007/build-journey-presentation.cjs ops/releases/crm-native-connection-20261007/start-existing.cjs ops/releases/crm-native-connection-20261007/health-existing.cjs ./ops/releases/crm-native-connection-20261007/
RUN node ops/releases/crm-native-connection-20261007/build-release.cjs /source /app /native-output "$GIT_SHA" \
 && node tools/prepared-worker/build.cjs /source/tools/prepared-worker /native-output /prepared-worker-output "$GIT_SHA"

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
COPY --from=native-build /prepared-worker-output/ /app/prepared-worker/
RUN chmod 0555 /app/prepared-worker /app/native-backend /app/native-backend/runtime /app/native-backend/runtime/own-foundation /app/native-backend/runtime/journey-read /app/native-pg-driver /app/presentation-release /app/presentation-release/public /app/presentation-release/public/assets /app/presentation-release/public/assets/panels
USER 1000:1000
# Native startup is admitted separately by Root on the existing Compose gateway.
# The historical pack/controller and public V2 files stay intact. Production uses
# the fresh immutable start-existing entrypoint, never the inherited old CMD.

# Existing Compose/envelope command and health overrides retain their admission.
ENV SHRIGMA_PROCESS_ROLE=api
CMD ["node","/app/prepared-worker/command.cjs","start"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node","/app/prepared-worker/command.cjs","health"]
