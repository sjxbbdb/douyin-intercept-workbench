FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV DB_PATH=/data/license.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown -R node:node /app /data
COPY --from=build /app/dist ./dist
USER node
VOLUME ["/data"]
EXPOSE 18080
CMD ["node", "dist/main.js"]
