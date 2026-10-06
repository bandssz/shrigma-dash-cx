FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:e1729ca3a6d064244c82a8df3d13bd1f3323797d5cfb8a80e1d6d0cf12345e32 AS admitted

# Export only public, immutable base files for the CI test fixture.
FROM scratch AS public-base-export
COPY --from=admitted /app/artifact-policy.cjs /app/bootstrap.cjs /app/canary-image.cjs /app/canary-start.cjs /app/image-pin.json /app/runtime-pack.json /

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS presentation-build
WORKDIR /source
COPY . .
COPY --from=admitted /app/artifact-policy.cjs /app/bootstrap.cjs /app/canary-image.cjs /app/canary-start.cjs /app/image-pin.json /app/runtime-pack.json /admitted-base/
RUN node ops/releases/crm-presentation-20261006/build-release.cjs /source /admitted-base /presentation-public

# Auth, SQLite, canary controls, the c3f pack and native activation stay in the
# admitted parent byte-for-byte. This layer only supplies a separate release.
FROM admitted AS runtime
ARG GIT_SHA
LABEL org.opencontainers.image.title="Shrigma CRM presentation release" \
      org.opencontainers.image.source="https://github.com/bandssz/shrigma-dash-cx" \
      org.opencontainers.image.revision="$GIT_SHA" \
      shrigma.presentation.base="sha256:e1729ca3a6d064244c82a8df3d13bd1f3323797d5cfb8a80e1d6d0cf12345e32"
USER 0:0
COPY --from=presentation-build /presentation-public/ /app/presentation-release/
COPY --chmod=0444 ops/releases/crm-presentation-20261006/release.cjs /app/presentation-release/release.cjs
RUN chmod 0555 /app/presentation-release /app/presentation-release/public /app/presentation-release/public/assets /app/presentation-release/public/assets/panels /app/presentation-release/public/creators /app/presentation-release/public/crm /app/presentation-release/public/gestao /app/presentation-release/public/organico
USER 1000:1000
# The parent's CMD is preserved. Root installs this release only in the
# original authenticated native startup continuation after its closed result.
