FROM mcr.microsoft.com/playwright:v1.64.0-noble
RUN npm install --prefix /qa --ignore-scripts --no-audit --no-fund --package-lock=false playwright@1.64.0
USER 1000:1000
ENTRYPOINT ["node", "/proof/analyst.cjs"]
