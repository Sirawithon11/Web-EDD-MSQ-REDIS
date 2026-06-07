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

## Event-driven design (RabbitMQ)

On top of the synchronous request path, the services communicate **asynchronously
via domain events** over a **RabbitMQ** broker.

How it works (per service, in `src/events/`):

1. **Topic exchange** — a single durable exchange `domain.events`. Producers
   publish each event with `routingKey = event type` (e.g. `product.created`).
2. **Publish** (`bus.js` → `publish(type, payload)`) — called **after** the
   business DB transaction commits. Messages are `persistent`, so together with
   durable queues they survive a broker restart.
3. **Consume** (`bus.js` → `startConsumer({ queue, bindings, handlers })`) — each
   service declares its **own durable queue** and binds it to the event types it
   cares about. Deliveries are dispatched to a handler in `handlers.js`, then
   **ack**'d on success / **nack**'d (no requeue) on failure.

This is a **pure broker** setup: there is no transactional outbox and no inbox
dedupe table. The trade-offs (vs. the previous outbox/inbox version):

- a crash in the gap between DB commit and publish can drop an event;
- a redelivery (consumer crash before ack) can re-run a handler — upserts are
  idempotent, but counter increments can double-count.

A production hardening step would re-add an outbox for guaranteed publish and an
inbox (or a dead-letter queue + retry) for safe redelivery.

### Queues & bindings

| Service  | Queue                    | Bound event types |
|----------|--------------------------|-------------------|
| product  | `product-service.events` | `order.placed`, `order.status.changed`, `order.deleted` |
| shopping | `shopping-service.events`| `product.created`, `product.updated`, `product.stock.changed`, `product.deleted` |
| user     | `user-service.events`    | `order.placed`, `order.status.changed`, `order.deleted` |

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

New env vars: `RABBITMQ_URL` and `EVENTS_EXCHANGE` (all services), plus optional
tuning `EVENTS_PREFETCH` and `EVENTS_RECONNECT_MS`. RabbitMQ runs as the
`rabbitmq` service in `docker-compose.yml`; its management UI is at
http://localhost:15672 (guest / guest). Run `docker compose up --build` to pick
everything up.

### Redis caching for `GET /api/users` (event-driven invalidation)

`user-service` caches the admin user list in **Redis** using the **cache-aside**
pattern, and keeps it correct via the same event stream:

- **Read** — `GET /users` returns the Redis copy on a hit (`X-Cache: HIT`);
  on a miss it reads Postgres, stores the result with a TTL, and returns it
  (`X-Cache: MISS`). See [cache.js](services/user-service/src/cache.js).
- **Invalidate (the event-driven part)** — the cache is dropped whenever a
  domain event changes user data:
  - `register` (a new user) busts it immediately at the local write.
  - the `order.placed` / `order.status.changed` / `order.deleted` handlers bust
    it because they mutate `totalSpent` / `ordersCount` (which are in the cached
    payload). This is cross-service: an order in **shopping** invalidates a cache
    in **user** purely through events. See
    [handlers.js](services/user-service/src/events/handlers.js).
- **TTL** is only a safety net (default 60s, `CACHE_TTL_SECONDS`); correctness
  comes from invalidation, not expiry.
- **Graceful degradation** — if Redis is down the endpoint serves straight from
  Postgres (cache ops become no-ops), so the cache is never a hard dependency.

Flow: `cache hit → return; miss → DB → SET key; relevant event → DEL key`.

Env: `REDIS_URL` (default `redis://localhost:6379`), `CACHE_TTL_SECONDS`. The
`redis` service is in `docker-compose.yml`; `npm install` (or a rebuild) is
needed because user-service now depends on `ioredis`.

> Caveat: the seeded list is large (~100k users) so a single cached blob is big,
> and every order invalidates it (lowering hit-rate). In production you'd
> paginate and cache per page, and/or exclude the volatile stat fields from the
> cached list. It's kept simple here to demonstrate the pattern.

### Redis caching for `GET /api/products`

`product-service` caches the (public) product list with the same cache-aside
approach, but it's **filtered + paginated**, so it uses a slightly more advanced
key strategy — see [cache.js](services/product-service/src/cache.js):

- **Per-query keys** — the cache key is a hash of the normalised
  `search / category / minPrice / maxPrice / sort / page / limit`, so every
  filter+page combination caches independently.
- **Generation counter for bulk invalidation** — keys embed a version
  (`products:list:v{N}:...`). A catalogue write does **one** `INCR
  products:list:ver`, which orphans *every* cached page/filter at once; the old
  keys then expire by TTL. No `SCAN`/`KEYS` sweep needed.
- **Invalidated on** `create` / `update` / `remove` (the product owner's own
  writes — immediate, read-your-writes). Stock-only changes from
  `decrement-stock` / `restock` are intentionally **not** invalidated — they're
  high-frequency (every checkout) and would gut the hit-rate; the short TTL keeps
  listed stock reasonably fresh, and stock is authoritative at checkout anyway.
- **TTL** default 30s (`PRODUCT_CACHE_TTL_SECONDS`), shorter than the user list
  because product listings show stock.
- **Graceful degradation** — same as user-service: Redis down ⇒ serve from
  Postgres.

Env: `REDIS_URL`, `PRODUCT_CACHE_TTL_SECONDS`. product-service now depends on
`ioredis` (rebuild / `npm install`).

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


