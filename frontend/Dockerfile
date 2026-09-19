# One Dockerfile, two portals. VITE_APP_TARGET picks the bundle copied
# into nginx (both are built so the source always exists):
#   public -> dist/        (employee portal, entry index.html)
#   admin  -> dist-admin/   (back-office,     entry admin.html)
# BACKEND_URL = where /api/* is proxied (same-origin, no CORS needed).
# ENTRY_FILE  = SPA fallback page (index.html or admin.html).
ARG VITE_APP_TARGET=public
ARG BACKEND_URL=http://backend-public:4000
ARG ENTRY_FILE=index.html

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN VITE_APP_TARGET=public node ./node_modules/vite/bin/vite.js build \
 && VITE_APP_TARGET=admin node ./node_modules/vite/bin/vite.js build

FROM nginx:alpine
ARG VITE_APP_TARGET
ARG BACKEND_URL
ARG ENTRY_FILE
COPY --from=build /app/dist /tmp/dist-public
COPY --from=build /app/dist-admin /tmp/dist-admin
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN if [ "${VITE_APP_TARGET}" = "admin" ]; then \
      cp -r /tmp/dist-admin/. /usr/share/nginx/html/; \
    else \
      cp -r /tmp/dist-public/. /usr/share/nginx/html/; \
    fi \
 && rm -rf /tmp/dist-public /tmp/dist-admin \
 && sed -i "s|__BACKEND_URL__|${BACKEND_URL}|g; s|__ENTRY_FILE__|${ENTRY_FILE}|g" \
      /etc/nginx/conf.d/default.conf
EXPOSE 80
