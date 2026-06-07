# Architecture

A microservice e-commerce platform demonstrating four patterns: **microservices**
(DB-per-service), a **message queue / broker** (Kafka), **event-driven design**
(domain events, CQRS read models, event-driven cache invalidation), and a
**cache-aside** layer (Redis).

> **Note on WebSockets:** the repository name mentions WebSocket, but there is no
> WebSocket implementation in the code yet. It is a planned addition (likely for
> pushing live order-status / analytics updates to the frontend). This document
> describes the system as it exists today and flags that gap.

---

## 1. High-level topology

```
                         ┌──────────────┐
   browser ────────────► │   Frontend   │  Next.js 14  :3000
                         └──────┬───────┘
                                │  NEXT_PUBLIC_API_URL
                                ▼
                         ┌──────────────┐
                         │   Gateway    │  Express  :8080   (verifies JWT)
                         └──┬────┬───┬───┘
              /api/users    │    │   │   /api/orders, /api/cart
          ┌─────────────────┘    │   └────────────────────┐
          ▼                      ▼                         ▼
   ┌─────────────┐       ┌───────────────┐        ┌────────────────┐
   │ user-service│       │product-service│        │shopping-service│
   │   :4001     │       │    :4002      │        │     :4003      │
   └──────┬──────┘       └──────┬────────┘        └───────┬────────┘
          ▼                     ▼                         ▼
     user_db :5433        product_db :5434          shopping_db :5435
          │                     │                         │
          └─────────────┬───────┴───────────┬─────────────┘
                        ▼                    ▼
                 ┌─────────────┐     ┌──────────────┐
                 │    Kafka    │     │     Redis     │
                 │ event topics│     │ cache-aside   │
                 │   :9092     │     │    :6380      │
                 └─────────────┘     └──────────────┘
```

Two communication planes run in parallel:

- **Synchronous (request/response)** — browser → gateway → service → DB, plus a
  few direct service-to-service HTTP calls on the checkout critical path.
- **Asynchronous (events)** — services publish domain events to Kafka; other
  services consume them to maintain read models, counters, and to invalidate
  caches. Events are *additive*; they never sit on the critical request path.

---

## 2. Components

| Component         | Tech                                   | Port  | Responsibility |
|-------------------|----------------------------------------|-------|----------------|
| Frontend          | Next.js 14 (App Router), React 18      | 3000  | UI; talks only to the gateway |
| Gateway           | Express, http-proxy-middleware, JWT    | 8080  | Single entry point, routing, JWT pre-check |
| user-service      | Express, Prisma                        | 4001  | Auth (JWT, bcrypt), user profiles, per-user order stats |
| product-service   | Express, Prisma                        | 4002  | Catalogue, stock, categories, sales counters |
| shopping-service  | Express, Prisma                        | 4003  | Cart, orders, checkout saga, analytics |
| user_db           | PostgreSQL 16                          | 5433  | user-service's private DB |
| product_db        | PostgreSQL 16                          | 5434  | product-service's private DB |
| shopping_db       | PostgreSQL 16                          | 5435  | shopping-service's private DB |
| Kafka             | confluentinc/cp-kafka:7.8.0 (KRaft, no ZooKeeper) | 9092 | Domain-event broker (one topic per event type) |
| Kafka UI          | provectuslabs/kafka-ui                 | 8081  | Web console: topics, messages, consumer-group lag |
| Redis             | redis:7                                | 6380  | Cache-aside store for user & product list reads |

All of it is orchestrated via [docker-compose.yml](docker-compose.yml).

---

## 3. Service boundaries (DB-per-service)

Each service **owns its own database** and is the only writer to it. There are no
foreign keys across services — cross-service references are plain integer ids
(e.g. `Cart.userId`, `OrderItem.productId`) that point at another service's data.

| Service          | Owns | Cross-service references (no FK) |
|------------------|------|----------------------------------|
| user-service     | `User` (+ projected `ordersCount`, `totalSpent`, `lastOrderAt`) | — |
| product-service  | `Category`, `Product` (+ `salesCount`), `AuditLog` | — |
| shopping-service | `Cart`, `CartItem`, `Order`, `OrderItem`, `AuditLog`, `ProductProjection` | `userId` → user, `productId` → product |

Because there are no cross-DB joins, data needed from another service is obtained
one of two ways: a **synchronous HTTP call** (checkout) or a **local read-model
projection kept fresh by events** (analytics).

---

## 4. Synchronous flow — the checkout saga

Checkout is the one place a service calls another service synchronously, because
stock reservation must be strongly consistent. See
[orderController.js](services/shopping-service/src/controllers/orderController.js).

```
POST /api/orders (gateway, auth) ──► shopping-service.checkout
  1. load cart + items
  2. getProductsByIds(...)         ── HTTP ──► product-service   (price/name snapshot)
  3. decrementStock(...)           ── HTTP ──► product-service   (atomic reserve)
        └─ on shortage: 409/404, nothing decremented, checkout fails cleanly
  4. prisma.$transaction:
        create Order + OrderItems, clear cart, write AuditLog   (atomic, local)
        └─ on failure AFTER step 3: restock(...) to compensate  (saga rollback)
  5. publish "order.placed"  (AFTER commit → Kafka)
```

This is a **compensation-based saga**: stock is reserved in product-service first;
if the local order transaction then fails, shopping-service issues a compensating
`restock` call. Order status changes (`updateStatus`) and deletions (`deleteOrder`)
similarly restock on cancellation, exactly once per transition.

The synchronous product HTTP client is [productClient.js](services/shopping-service/src/productClient.js).

---

## 5. Asynchronous flow — event-driven design (Kafka)

### 5.1 Broker topology

**One topic per event type** (e.g. `product.created`). Producers send each event to
the topic named after the event type. Each consuming service joins its **own
consumer group** and subscribes to the topics it cares about, so its read offsets
are tracked independently (the Kafka equivalent of a durable per-service queue) and
adding or removing a consumer never touches the producer. The shared bus
implementation is identical per service:
[product bus.js](services/product-service/src/events/bus.js)
(and the matching files under shopping/ and user/).

Kafka runs in **KRaft mode** (no ZooKeeper) as a single broker. Topics are
auto-created on first publish/subscribe with one partition each.

Key properties:
- **Durable commit log + per-group offsets** → events persist and a restarted
  consumer resumes from its last committed offset.
- **Publish after commit** → events are sent only once the business DB transaction
  has committed.
- **Log-and-continue on handler failure** → the offset still commits, so a poison
  message is dropped rather than looping forever (mirrors the old nack-no-requeue).
- **Auto-reconnect** → kafkajs retries internally and the bus retries the initial
  connect, so service startup never hard-fails if Kafka is not yet up.

### 5.2 Consumer groups & subscribed topics

| Service  | Consumer group     | Subscribed topics |
|----------|--------------------|-------------------|
| product  | `product-service`  | `order.placed`, `order.status.changed`, `order.deleted` |
| shopping | `shopping-service` | `product.created`, `product.updated`, `product.stock.changed`, `product.deleted` |
| user     | `user-service`     | `order.placed`, `order.status.changed`, `order.deleted` |

### 5.3 Events & reactions

| Producer | Event | Consumer → effect |
|----------|-------|-------------------|
| user     | `user.registered` | *(no subscriber yet — emitted for future use)* |
| product  | `product.created` / `product.updated` / `product.stock.changed` / `product.deleted` | **shopping** → maintains `ProductProjection` read model (CQRS) |
| shopping | `order.placed` | **user** → `ordersCount`/`totalSpent`/`lastOrderAt` + cache bust; **product** → `salesCount` |
| shopping | `order.status.changed` / `order.deleted` | **user** & **product** → reverse the above on cancel/delete |

Handlers: [user](services/user-service/src/events/handlers.js) ·
[product](services/product-service/src/events/handlers.js) ·
[shopping](services/shopping-service/src/events/handlers.js).

### 5.4 CQRS read model

shopping-service keeps a local `ProductProjection` table — a denormalised copy of
product-service's catalogue, updated purely by consuming `product.*` events. The
heavy **analytics** queries
([analyticsController.js](services/shopping-service/src/controllers/analyticsController.js))
read product data from this projection (with an HTTP fallback for not-yet-projected
ids) instead of calling product-service synchronously on every report.

### 5.5 Delivery guarantees & known trade-offs

This is a **pure broker** setup — there is *no* transactional outbox and *no* inbox
dedupe table (an earlier version had them; they were removed for simplicity). The
consequences:

- A crash in the gap between DB commit and publish can **drop** an event
  (at-most-once for that window).
- A redelivery (consumer crash before ack) can **re-run** a handler. Upserts are
  idempotent and safe; counter increments (`salesCount`, `ordersCount`) can
  double-count.

A production hardening step would re-add an **outbox** for guaranteed publish and an
**inbox / dead-letter queue + retry** for safe redelivery.

---

## 6. Caching — cache-aside on Redis

Two read endpoints are cached with the cache-aside pattern, with **event-driven
invalidation** as the correctness mechanism (TTL is only a safety net).

### 6.1 `GET /api/users` (user-service)
See [user cache.js](services/user-service/src/cache.js).
- Hit → return Redis copy (`X-Cache: HIT`); miss → Postgres, then `SET` with TTL
  (`X-Cache: MISS`).
- Invalidated on `register` (local write) **and** on `order.placed` /
  `order.status.changed` / `order.deleted` events (because they mutate cached
  `totalSpent`/`ordersCount`). This is **cross-service invalidation**: an order in
  shopping busts a cache in user, purely through events.
- TTL default 60s (`CACHE_TTL_SECONDS`).

### 6.2 `GET /api/products` (product-service)
See [product cache.js](services/product-service/src/cache.js).
- **Per-query keys** — key is a hash of `search/category/minPrice/maxPrice/sort/page/limit`,
  so each filter+page combo caches independently.
- **Generation-counter invalidation** — keys embed a version
  (`products:list:v{N}:...`); a catalogue write does one `INCR products:list:ver`,
  orphaning every cached page at once (no `SCAN`/`KEYS` sweep). Old keys expire by TTL.
- Invalidated on `create`/`update`/`remove`. Stock-only changes
  (`decrement-stock`/`restock`) are intentionally **not** invalidated (too frequent;
  short TTL keeps it fresh enough; stock is authoritative at checkout).
- TTL default 30s (`PRODUCT_CACHE_TTL_SECONDS`).

### 6.3 Graceful degradation
If Redis is down both endpoints serve straight from Postgres (cache ops become
no-ops). The cache is never a hard dependency.

---

## 7. Authentication & authorization

- **JWT** issued by user-service on register/login (passwords bcrypt-hashed).
- **Gateway** does a fast-fail JWT verification on protected routes
  (`/api/cart`, `/api/orders`) before proxying — see [gateway/src/index.js](gateway/src/index.js).
- Each **service re-verifies** the token itself (`middleware/auth.js`), so a service
  is safe even if reached directly. Role checks (`ADMIN`) gate admin endpoints
  (product writes, order status, analytics, audit logs, user list).
- The same `JWT_SECRET` is shared by gateway and all services.

---

## 8. Request routing (gateway)

The gateway is a thin Express + `http-proxy-middleware` proxy with **no body
parser** (bodies stream straight through). Path prefixes are rewritten by *adding*
the service-local prefix (http-proxy-middleware v3 has already stripped the mount
path):

| Gateway path     | Target service    | Rewritten to | Auth at gateway |
|------------------|-------------------|--------------|-----------------|
| `/api/users/*`   | user-service      | `/users/*`   | no (login/register are public) |
| `/api/products/*`| product-service   | `/products/*`| no (catalogue is public) |
| `/api/cart/*`    | shopping-service  | `/cart/*`    | **yes** |
| `/api/orders/*`  | shopping-service  | `/orders/*`  | **yes** |

---

## 9. Data models (per service)

**user-service** — `User` (with event-projected `ordersCount`, `totalSpent`,
`lastOrderAt`), `Role` enum.

**product-service** — `Category`, `Product` (with event-projected `salesCount`),
`AuditLog`.

**shopping-service** — `Cart`, `CartItem`, `Order`, `OrderItem` (price/name snapshot
at purchase time), `AuditLog`, `OrderStatus` enum, and `ProductProjection` (CQRS read
model).

Schemas: [user](services/user-service/prisma/schema.prisma) ·
[product](services/product-service/prisma/schema.prisma) ·
[shopping](services/shopping-service/prisma/schema.prisma).

---

## 10. Source layout

```
.
├── docker-compose.yml          # full stack: DBs, Kafka, Redis, services, gateway, frontend
├── gateway/                    # Express API gateway + JWT pre-check
├── services/
│   ├── user-service/           # auth, users, user stats        (user_db)
│   ├── product-service/        # catalogue, stock, categories   (product_db)
│   └── shopping-service/       # cart, orders, analytics        (shopping_db)
└── frontend/                   # Next.js app (App Router)
```

Each service:
```
service/
├── prisma/
│   ├── schema.prisma
│   └── seed.js
├── src/
│   ├── index.js                # express bootstrap + connectBus/startConsumer
│   ├── prisma.js               # shared PrismaClient
│   ├── cache.js                # (user & product) Redis cache-aside
│   ├── audit.js                # (product & shopping) audit-log writer
│   ├── events/
│   │   ├── bus.js              # Kafka connect/publish/consume
│   │   └── handlers.js         # inbound event handlers
│   ├── routes/
│   ├── controllers/
│   └── middleware/auth.js      # JWT verify + role guard
├── Dockerfile
└── package.json
```

---

## 11. Patterns summary

| Pattern | Where |
|---------|-------|
| Microservices, DB-per-service | 3 services, 3 isolated Postgres DBs, no cross-DB FK |
| API Gateway | `gateway/` — single entry, routing, JWT fast-fail |
| Saga (compensation) | checkout: reserve stock → compensate with restock on failure |
| Message queue / broker | Kafka (KRaft), one topic per event type |
| Event-driven design | domain events drive projections, counters, cache busts |
| CQRS read model | `ProductProjection` in shopping-service for analytics |
| Cache-aside | Redis on `GET /users` and `GET /products`, event-invalidated |
| Audit logging | append-only `AuditLog` in product & shopping services |
| WebSocket / live push | **not yet implemented** (planned) |

---

## 12. Configuration (key env vars)

| Var | Used by | Purpose |
|-----|---------|---------|
| `DATABASE_URL` | each service | its own Postgres connection |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | gateway + all services | token signing/verification |
| `KAFKA_BROKERS`, `KAFKA_CLIENT_ID` | all services | broker bootstrap list + client id |
| `EVENTS_RECONNECT_MS` | all services | connect/attach retry delay |
| `REDIS_URL`, `REDIS_PASSWORD` | user + product | cache store |
| `CACHE_TTL_SECONDS` | user | user-list cache TTL (60s) |
| `PRODUCT_CACHE_TTL_SECONDS` | product | product-list cache TTL (30s) |
| `PRODUCT_SERVICE_URL` | shopping | synchronous checkout calls |
| `*_SERVICE_URL` | gateway | proxy targets |
| `NEXT_PUBLIC_API_URL` | frontend | gateway URL for the browser |
```
