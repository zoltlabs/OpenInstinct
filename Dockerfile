FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @openinstinct/web build

FROM build AS web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@openinstinct/web", "start"]

FROM build AS worker
ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "@openinstinct/worker", "start"]
