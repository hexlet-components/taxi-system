FROM node:26-alpine
WORKDIR /app
RUN npm install --global pnpm@12.21.0
COPY baseline/package.json baseline/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY monolith/src ./monolith/src
COPY monolith/package.json ./monolith/package.json
COPY baseline/src ./baseline/src
CMD ["node", "baseline/src/process.ts"]
