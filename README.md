# Microservice E-Commerce Platform

A microservice-based e-commerce website.

- **Frontend** — React via **Next.js**
- **API Gateway** — Express, single entry point that routes to the services and verifies JWTs
- **3 backend services** — `user`, `product`, `shopping`, each an **Express** app
- **Database** — **Postgres**, one database *per service* (DB-per-service pattern), accessed via **Prisma**
- **Auth** — JWT issued by the user service, verified by the gateway & shopping service

```
                       ┌──────────────┐
   browser ──────────► │   Frontend   │  Next.js  :3000
                       └──────┬───────┘
                              │  NEXT_PUBLIC_API_URL
                              ▼
                       ┌──────────────┐
                       │   Gateway    │  Express  :8080   (verifies JWT)
                       └──┬────┬───┬───┘
            /api/users    │    │   │   /api/orders, /api/cart
        ┌─────────────────┘    │   └────────────────────┐
        ▼                      ▼                         ▼
 ┌─────────────┐       ┌──────────────┐         ┌────────────────┐
 │ user-service│       │product-service│        │shopping-service│
 │   :4001     │       │    :4002     │         │     :4003      │
 └──────┬──────┘       └──────┬───────┘         └───────┬────────┘
        ▼                     ▼                         ▼
   user_db :5433        product_db :5434          shopping_db :5435
```

## Tech stack

| Layer        | Tech                                   |
|--------------|----------------------------------------|
| Frontend     | Next.js 14 (App Router), React 18      |
| Gateway      | Express, http-proxy-middleware, JWT    |
| Services     | Express, Prisma ORM                    |
| Database     | PostgreSQL 16 (one per service)        |
| Auth         | JWT (bcrypt-hashed passwords)          |
| Orchestration| Docker Compose                         |

## Ports

| Component         | URL / Port              |
|-------------------|-------------------------|
| Frontend          | http://localhost:3000   |
| Gateway           | http://localhost:8080   |
| user-service      | http://localhost:4001   |
| product-service   | http://localhost:4002   |
| shopping-service  | http://localhost:4003   |
| user_db (Postgres)| localhost:5433          |
| product_db        | localhost:5434          |
| shopping_db       | localhost:5435          |

---

## Quick start (Docker — recommended)

```bash
# 1. Build & start everything (each service auto-creates its tables on startup)
docker compose up --build

# 2. In another terminal, seed sample data.
#    Order matters: products must exist before shopping seeds orders.
docker compose exec user-service     npm run seed
docker compose exec product-service  npm run seed
docker compose exec shopping-service npm run seed
```

Then open **http://localhost:3000** and log in with `admin@shop.dev` / `admin123`.

> Tables are created automatically via `prisma db push` when each service
> container starts, so you only need to run the seeds above.

---

## Local development (without Docker for the apps)

You still need Postgres. Easiest is to start just the databases:

```bash
docker compose up user-db product-db shopping-db
```

Then in each folder (`services/*`, `gateway`, `frontend`):

```bash
cp .env.example .env      # adjust if needed
npm install
```

For each service:

```bash
npx prisma generate
npx prisma db push        # create tables
npm run seed              # load sample data
npm run dev               # start with nodemon
```

Gateway & frontend:

```bash
npm run dev
```

---

## Seed data (enterprise scale)

Each `npm run seed` loads an enterprise-scale dataset (all sizes are
env-overridable — see below):

- **user-service** — ~100k users (1 admin; the rest `userN@shop.dev` / `password123`)
- **product-service** — ~20k products across 8 categories
- **shopping-service** — ~500k orders (~1.5M line items) + ~5k active carts, referencing seeded user & product IDs

For performance the seeds use batched `createMany` and reuse a single bcrypt
hash for the shared user password (hashing every user individually would take
hours). Override the scale with env vars, e.g.:

```bash
docker compose exec -e SEED_PRODUCTS=5000 product-service  npm run seed
docker compose exec -e SEED_USERS=10000   user-service     npm run seed
docker compose exec -e SEED_USERS=10000 -e SEED_ORDERS=50000 shopping-service npm run seed
```

Supported vars: `SEED_USERS`, `SEED_USER_PASSWORD`, `SEED_PRODUCTS`,
`SEED_ORDERS`, `SEED_CARTS`, `SEED_SAMPLE`. Keep `SEED_USERS` consistent between
the user and shopping seeds so order `userId`s stay in range, and seed
product-service **before** shopping-service.

---

## Default credentials

| Role  | Email             | Password     |
|-------|-------------------|--------------|
| Admin | admin@shop.dev    | admin123     |
| User  | user1@shop.dev    | password123  |

---

## API overview (via gateway, prefix `/api`)

### Users — `user-service`
| Method | Path                | Auth | Description            |
|--------|---------------------|------|------------------------|
| POST   | /api/users/register | —    | Register, returns JWT  |
| POST   | /api/users/login    | —    | Login, returns JWT     |
| GET    | /api/users/me       | ✓    | Current user profile   |
| GET    | /api/users          | ✓    | List users (admin)     |

### Products — `product-service`
| Method | Path                | Auth | Description            |
|--------|---------------------|------|------------------------|
| GET    | /api/products       | —    | List / filter products |
| GET    | /api/products/:id   | —    | Product detail         |
| POST   | /api/products       | ✓    | Create product (admin) |
| PUT    | /api/products/:id   | ✓    | Update product (admin) |
| DELETE | /api/products/:id   | ✓    | Delete product (admin) |

### Shopping — `shopping-service`
| Method | Path                | Auth | Description            |
|--------|---------------------|------|------------------------|
| GET    | /api/cart           | ✓    | Get current user cart  |
| POST   | /api/cart/items     | ✓    | Add item to cart       |
| DELETE | /api/cart/items/:id | ✓    | Remove cart item       |
| POST   | /api/orders         | ✓    | Checkout cart -> order |
| GET    | /api/orders         | ✓    | List user orders       |
| GET    | /api/orders/:id     | ✓    | Order detail           |

---

## Event-driven design (no message queue)

On top of the synchronous request path, the services communicate **asynchronously
via domain events** using the **Transactional Outbox + HTTP relay** pattern — no
Kafka/RabbitMQ/Redis broker involved.

How it works (per service, in `src/events/`):

1. **Outbox** — when a service changes state, it writes a row to its own
   `outbox_events` table **inside the same DB transaction** as the change
   (`publishEvent(tx, type, payload)`). The event can never be lost or diverge
   from the data it describes.
2. **Relay** (`relay.js`) — a background loop polls `outbox_events` for unsent
   rows and **HTTP-POSTs** each to its subscribers' `/events` endpoint (routing
   lives in `subscriptions.js`). Success → marked `PUBLISHED`; failure →
   retried with attempt counting, then `FAILED`. Delivery is **at-least-once**.
3. **Inbox** (`consumer.js`) — the `/events` endpoint dedupes via an
   `inbox_events` table and runs the matching handler **in the same transaction**
   as the dedupe insert, giving **effectively-once** processing. Requests carry a
   shared `x-event-secret` header.

### Events & reactions

| Producer | Event | Consumer → effect |
|----------|-------|-------------------|
| user     | `user.registered` | *(no subscriber yet — emitted for future use)* |
| product  | `product.created` / `product.updated` / `product.stock.changed` / `product.deleted` | **shopping** → maintains a local `product_projection` read model (CQRS) |
| shopping | `order.placed` | **user** → `ordersCount`/`totalSpent`/`lastOrderAt`; **product** → `salesCount` |
| shopping | `order.status.changed` / `order.deleted` | **user** & **product** → reverse the above when an order is cancelled/removed |

The **shopping analytics** endpoints now read product data from the local
`product_projection` (falling back to an HTTP call only for ids not yet
projected) instead of calling product-service synchronously on every request.

> The synchronous checkout saga (reserve stock in product-service, compensate on
> failure) is **unchanged** — events are additive, for projections and side
> effects, not for the stock-reservation critical path.

New env vars: `EVENT_SECRET` (shared), `USER_SERVICE_URL` (shopping),
`SHOPPING_SERVICE_URL` (product), plus optional tuning `OUTBOX_POLL_MS`,
`OUTBOX_BATCH`, `OUTBOX_MAX_ATTEMPTS`. The new tables/columns are created
automatically by `prisma db push` on container start (run `docker compose up
--build` to pick them up).

---

## Project structure

```
.
├── docker-compose.yml
├── gateway/                  # Express API gateway + JWT verification
├── services/
│   ├── user-service/         # auth, users        (user_db)
│   ├── product-service/      # catalog            (product_db)
│   └── shopping-service/     # cart + orders      (shopping_db)
└── frontend/                 # Next.js app
```

Each service folder contains:

```
service/
├── prisma/
│   ├── schema.prisma
│   └── seed.js
├── src/
│   ├── index.js              # express bootstrap
│   ├── prisma.js             # shared PrismaClient
│   ├── routes/
│   ├── controllers/
│   └── middleware/
├── .env.example
├── Dockerfile
└── package.json
```


