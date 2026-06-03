FROM node:20-alpine

WORKDIR /app

# Prisma needs OpenSSL on Alpine, otherwise the query/schema engine fails to start.
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

EXPOSE 4003

# Create/sync tables on startup (idempotent), then launch the service.
# Seeding is NOT run here so data persists across restarts.
# Seed manually when needed:  docker compose exec shopping-service npm run seed
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm start"]

