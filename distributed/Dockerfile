FROM node:26-alpine
WORKDIR /app
RUN npm install --global pnpm@12.21.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
CMD ["node", "src/server.ts"]
