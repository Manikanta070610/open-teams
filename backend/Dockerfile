FROM node:22-alpine
WORKDIR /app
# Lockfile first so rebuilds stay cached and deterministic (npm ci, not install).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
# ADMIN_MODE picks the personality at runtime:
#   public = employee API on PORT (default 4000)
#   admin  = back-office API on ADMIN_PORT (default 4001)
EXPOSE 4000 4001
CMD ["node", "src/index.js"]
