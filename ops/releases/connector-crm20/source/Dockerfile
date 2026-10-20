FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f
WORKDIR /app
RUN npm install --global pnpm@11.25.0 --ignore-scripts
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY src/ ./src/
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=3000 DATA_DIRECTORY=/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "require('http').get({hostname:'127.0.0.1',port:3000,path:'/health',headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host}},r=>{r.resume();process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"
CMD ["sh","-c","node src/admin.mjs initialize && exec node src/server.mjs"]
