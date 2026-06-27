FROM node:20-alpine

WORKDIR /app

# Prisma needs OpenSSL on Alpine, otherwise the query/schema engine fails to start.
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

EXPOSE 50051

# Create/sync tables on startup (idempotent), then launch the service.
# --accept-data-loss lets db push drop the obsolete outbox/inbox tables left
# over from the pre-RabbitMQ design (those tables are no longer in the schema).
# Seeding is NOT run here so data persists across restarts.
# Seed manually when needed:  docker compose exec user-service npm run seed
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && npm start"]

