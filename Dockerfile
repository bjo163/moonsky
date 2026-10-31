# MOONSKY standalone runtime image.
# The build stage installs the workspace, builds the library packages, the
# operator UI and the Fastify service. The runtime stage keeps the same paths so
# pnpm workspace links keep resolving without a registry or vendor directory.

FROM node:24-slim AS build
RUN npm install --global pnpm@10.33.4
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# Default location for MOONSKY_WHATSAPP_AUTH_DIR when an operator enables WhatsApp.
# Empty by default; mount a private volume here to persist the session across restarts.
RUN mkdir -p /app/whatsapp-session
EXPOSE 3005
CMD ["node", "apps/moonsky/dist/index.js"]
