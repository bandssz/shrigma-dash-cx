FROM mcr.microsoft.com/playwright@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
RUN npm install --prefix /qa --ignore-scripts --no-audit --no-fund --package-lock=false playwright@1.64.0
COPY analyst.cjs read-policy.cjs /runner/
USER 1000:1000
ENTRYPOINT ["node","/runner/analyst.cjs"]
