FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.mjs ./
COPY scripts/build.mjs scripts/build.mjs
COPY public ./public
COPY worker ./worker
COPY drizzle ./drizzle
RUN node scripts/build.mjs \
    && install -d -m 0700 -o node -g node /app/data \
    && touch /app/data/.initialized \
    && chown node:node /app/data/.initialized
USER node
EXPOSE 8788
CMD ["node", "server.mjs"]
