FROM ghcr.io/bandssz/shrigma-dash-crm-presentation@sha256:88b082d574394ef56623e5cb429ace65dbca99c9d1de698fa6a1cf83e1a17861 AS presentation-parent

FROM presentation-parent AS presentation-build
USER 0:0
WORKDIR /source
COPY influs.html organico.html ./
COPY assets/panels/influs.css assets/panels/influs.js assets/panels/organico.css assets/panels/organico.js ./assets/panels/
COPY services/dashboard-operational/build.cjs ./services/dashboard-operational/
COPY services/dashboard-operational/public/entry.js ./services/dashboard-operational/public/
COPY ops/releases/crm-presentation-v2-20261006/release.cjs ops/releases/crm-presentation-v2-20261006/build-release.cjs ./ops/releases/crm-presentation-v2-20261006/
RUN node -e 'const fs=require("node:fs"),path=require("node:path"),expected=["influs.html","organico.html","assets/panels/influs.css","assets/panels/influs.js","assets/panels/organico.css","assets/panels/organico.js","services/dashboard-operational/build.cjs","services/dashboard-operational/public/entry.js","ops/releases/crm-presentation-v2-20261006/release.cjs","ops/releases/crm-presentation-v2-20261006/build-release.cjs"].sort(),actual=[];function walk(dir,prefix=""){for(const n of fs.readdirSync(dir)){const file=path.join(dir,n),s=fs.lstatSync(file);if(s.isSymbolicLink())throw Error("PRESENTATION_V2_SOURCE_REFUSED");if(s.isDirectory())walk(file,prefix+n+"/");else{if(!s.isFile()||s.nlink!==1)throw Error("PRESENTATION_V2_SOURCE_REFUSED");actual.push(prefix+n);}}}walk("/source");if(process.version!=="v22.23.3"||JSON.stringify(actual.sort())!==JSON.stringify(expected))throw Error("PRESENTATION_V2_SOURCE_REFUSED");'
RUN node ops/releases/crm-presentation-v2-20261006/build-release.cjs /source /app /app/presentation-release /presentation-delta

# Only the separate presentation policy, manifest and six public replacements
# change. The seven V1 public payloads are reused directly from the parent.
FROM presentation-parent AS runtime
ARG GIT_SHA
LABEL org.opencontainers.image.title="Shrigma presentation V2" \
      org.opencontainers.image.source="https://github.com/bandssz/shrigma-dash-cx" \
      org.opencontainers.image.revision="$GIT_SHA" \
      shrigma.presentation.parent="sha256:88b082d574394ef56623e5cb429ace65dbca99c9d1de698fa6a1cf83e1a17861" \
      shrigma.presentation.base="sha256:e1729ca3a6d064244c82a8df3d13bd1f3323797d5cfb8a80e1d6d0cf12345e32"
USER 0:0
COPY --from=presentation-build /presentation-delta/ /app/presentation-release/
COPY --chmod=0444 ops/releases/crm-presentation-v2-20261006/release.cjs /app/presentation-release/release.cjs
RUN chmod 0555 /app/presentation-release /app/presentation-release/public /app/presentation-release/public/assets /app/presentation-release/public/assets/panels
USER 1000:1000
# Preserve the parent's CMD. Root alone admits the new manifest/13-file health
# guard on the existing Compose service; no native controller is changed here.
