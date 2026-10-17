FROM ghcr.io/bandssz/shrigma-dash-operational-canary@sha256:266102a4821c31df343cc25355cfef6098fae7c836a24d20191e39577f05997b
USER root
RUN node -e 'const f=require("fs"),c=require("crypto"),a=require("assert/strict");for(const [p,h]of [["campaign-contract.js","34c4f0e5a8b4512b255ee2deb6636d53a1a6051e74c0f9586e87f987fb8b2390"],["campaign-service.js","1858178696d8537a23a2a49df20df45b786548efb3d266c4c6d8d21725a5d629"]])a.equal(c.createHash("sha256").update(f.readFileSync("/app/n8n/growth/"+p)).digest("hex"),h);'
COPY campaign-contract.js campaign-service.js /app/n8n/growth/
COPY smoke.cjs /app/sender-correction-smoke.cjs
RUN node --check /app/n8n/growth/campaign-contract.js && node --check /app/n8n/growth/campaign-service.js
USER node
RUN node --test /app/sender-correction-smoke.cjs
ARG PATCH_REVISION
LABEL com.shrigma.original-revision="03a02b4c98f471e6739c8a7cbe46e49aa4cbf285" com.shrigma.sender-patch-revision=$PATCH_REVISION
