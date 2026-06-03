FROM node:20-alpine

WORKDIR /app

# Prisma needs OpenSSL on Alpine, otherwise the query/schema engine fails to start.
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

EXPOSE 4001

# Create/sync tables on startup (idempotent), then launch the service.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run seed && npm start"]

