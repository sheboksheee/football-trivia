# Football Trivia — single image serving the API, WebSocket gateway and the built PWA.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @ft/web build && pnpm --filter @ft/server build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production PORT=8787 WEB_DIST=/app/apps/web/dist
COPY --from=build /app /app
RUN pnpm install --frozen-lockfile --prod --filter @ft/server... 
USER node
EXPOSE 8787
HEALTHCHECK CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
