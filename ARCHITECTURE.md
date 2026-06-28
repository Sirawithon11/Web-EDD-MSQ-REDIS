# Architecture

A microservice e-commerce platform demonstrating four patterns: **microservices**
(DB-per-service), a **message queue / broker** (Kafka), **event-driven design**
(domain events, CQRS read models, event-driven cache invalidation), and a
**cache-aside** layer (Redis).

> **Note on WebSockets:** the gateway exposes a WebSocket endpoint (`/ws`) that
> pushes **live product-stock updates** to the browser. It joins its own Kafka
> consumer group (`gateway`) on `product.stock.changed` — the event product-service
> emits when stock moves on the order path (checkout decrement and restock on
> cancel/rollback) — and fans each one out to all connected clients, which patch the affected
> product card in place without re-fetching. See [gateway/src/realtime.js](gateway/src/realtime.js)
> and the frontend hook [useStockSocket.js](frontend/lib/useStockSocket.js).

---

## 1. High-level topology

```
                         ┌──────────────┐
   browser ──REST/WS───► │   Frontend   │  Next.js 14  :3000
                         └──────┬───────┘
                                │  NEXT_PUBLIC_API_URL (REST)
                                ▼
                         ┌──────────────┐
                         │   Gateway    │  Express :8080  (REST → gRPC, verifies JWT)
                         └──┬────┬───┬───┘
                   gRPC     │    │   │    gRPC
          ┌─────────────────┘    │   └────────────────────┐
          ▼                      ▼                         ▼
   ┌─────────────┐       ┌───────────────┐        ┌────────────────┐
   │ user-service│       │product-service│◄──gRPC─│shopping-service│
   │ gRPC :50051 │       │  gRPC :50052  │        │  gRPC :50053   │
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

- **Synchronous (request/response)** — the browser talks **REST** to the gateway;
  the gateway translates each request into a **gRPC** call to a service, and the
  one service-to-service call on the checkout critical path (shopping → product)
  is **gRPC** too. The only HTTP in the backend is the gateway's public REST/WS edge.
- **Asynchronous (events)** — services publish domain events to Kafka; other
  services consume them to maintain read models, counters, and to invalidate
  caches. Events are *additive*; they never sit on the critical request path.

---

## 2. Components

| Component         | Tech                                   | Port  | Responsibility |
|-------------------|----------------------------------------|-------|----------------|
| Frontend          | Next.js 14 (App Router), React 18      | 3000  | UI; talks REST to the gateway only |
| Gateway           | Express (REST) → gRPC clients, JWT     | 8080  | Single entry point, REST→gRPC translation, JWT pre-check |
| user-service      | gRPC (@grpc/grpc-js), Prisma           | 50051 | Auth (JWT, bcrypt), user profiles, per-user order stats |
| product-service   | gRPC (@grpc/grpc-js), Prisma           | 50052 | Catalogue, stock, categories, sales counters |
| shopping-service  | gRPC (@grpc/grpc-js), Prisma           | 50053 | Cart, orders, checkout saga, analytics |
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
POST /api/orders (gateway REST → gRPC, auth) ──► shopping-service.Checkout
  1. load cart + items
  2. getProductsByIds(...)         ── gRPC ──► product-service   (price/name snapshot)
  3. decrementStock(...)           ── gRPC ──► product-service   (atomic reserve)
        └─ on shortage: FAILED_PRECONDITION/NOT_FOUND, nothing decremented, fails cleanly
  4. prisma.$transaction:
        create Order + OrderItems, clear cart, write AuditLog   (atomic, local)
        └─ on failure AFTER step 3: restock(...) to compensate  (saga rollback)
  5. publish "order.placed"  (AFTER commit → Kafka)
```

This is a **compensation-based saga**: stock is reserved in product-service first;
if the local order transaction then fails, shopping-service issues a compensating
`restock` call. Order status changes (`UpdateStatus`) and deletions (`DeleteOrder`)
similarly restock on cancellation, exactly once per transition.

The synchronous product **gRPC** client is
[productClient.js](services/shopping-service/src/productClient.js); it calls
product-service's typed `BulkByIds` / `DecrementStock` / `Restock` RPCs and
re-maps `FAILED_PRECONDITION → 409` / `NOT_FOUND → 404` so the checkout logic is
unchanged. The contract is [product.proto](services/product-service/proto/product.proto).

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
read product data from this projection (with a **gRPC** fallback for not-yet-projected
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

## 8. Request routing (gateway — REST → gRPC)

The gateway is an Express app that **parses the JSON body** (8 MB limit for
base64 product images) and maps each REST route to a **gRPC** method on the right
service. It forwards the JWT in gRPC metadata (`authorization`), translates the
gRPC status back to an HTTP status, copies the service's `x-cache` trailing
metadata into the `X-Cache` header, and restores the original success status
(201 on create/checkout, 204 on delete). The client/translation layer is
[grpcClients.js](gateway/src/grpcClients.js).

| Gateway REST     | Target service    | gRPC method(s)            | Auth at gateway |
|------------------|-------------------|---------------------------|-----------------|
| `/api/users/*`   | user-service      | `UserService.*`           | no (services enforce; login/register public) |
| `/api/products/*`| product-service   | `ProductService.*`        | no (catalogue is public) |
| `/api/cart/*`    | shopping-service  | `ShoppingService.*`       | **yes** |
| `/api/orders/*`  | shopping-service  | `ShoppingService.*`       | **yes** |

gRPC → HTTP status mapping: `INVALID_ARGUMENT→400`, `UNAUTHENTICATED→401`,
`PERMISSION_DENIED→403`, `NOT_FOUND→404`, `ALREADY_EXISTS`/`FAILED_PRECONDITION→409`,
`UNAVAILABLE→503`, else `500`.

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
├── gateway/
│   ├── proto/                  # user/product/shopping .proto (client side)
│   └── src/                    # Express REST → gRPC translator + JWT pre-check + /ws
├── services/
│   ├── user-service/           # auth, users, user stats        (user_db)
│   ├── product-service/        # catalogue, stock, categories   (product_db)
│   └── shopping-service/       # cart, orders, analytics        (shopping_db)
└── frontend/                   # Next.js app (App Router)
```

Each service:
```
service/
├── proto/                      # this service's gRPC contract (.proto)
├── prisma/
│   ├── schema.prisma
│   └── seed.js
├── src/
│   ├── index.js                # gRPC server bootstrap + connectBus/startConsumer
│   ├── prisma.js               # shared PrismaClient
│   ├── cache.js                # (user & product) Redis cache-aside
│   ├── audit.js                # (product & shopping) audit-log writer
│   ├── events/
│   │   ├── bus.js              # Kafka connect/publish/consume
│   │   └── handlers.js         # inbound event handlers
│   └── grpc/
│       ├── server.js           # bind the gRPC server
│       ├── handlers.js         # RPC implementations (business logic)
│       ├── auth.js             # JWT-from-metadata verify + role guard
│       └── load.js             # proto loader
├── Dockerfile
└── package.json
```

---

## 11. Patterns summary

| Pattern | Where |
|---------|-------|
| Microservices, DB-per-service | 3 services, 3 isolated Postgres DBs, no cross-DB FK |
| gRPC service-to-service | all backend calls (gateway→service, shopping→product) over gRPC + Protobuf |
| API Gateway | `gateway/` — single entry, REST→gRPC translation, JWT fast-fail |
| Saga (compensation) | checkout: reserve stock → compensate with restock on failure |
| Message queue / broker | Kafka (KRaft), one topic per event type |
| Event-driven design | domain events drive projections, counters, cache busts |
| CQRS read model | `ProductProjection` in shopping-service for analytics |
| Cache-aside | Redis on `GET /users` and `GET /products`, event-invalidated |
| Audit logging | append-only `AuditLog` in product & shopping services |
| WebSocket / live push | gateway `/ws` fans out `product.stock.changed` (Kafka group `gateway`) → live stock in the browser |

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
| `GRPC_PORT` | each service | port the service's gRPC server binds (50051/50052/50053) |
| `PRODUCT_GRPC_ADDR` | shopping | product-service gRPC target (checkout saga) |
| `USER_GRPC_ADDR`, `PRODUCT_GRPC_ADDR`, `SHOPPING_GRPC_ADDR` | gateway | gRPC targets |
| `NEXT_PUBLIC_API_URL` | frontend | gateway REST URL for the browser |
```

---

## 13. Seeding the databases

Seeding is **not** run automatically on container start (so data persists across
restarts). Each service exposes an `npm run seed` script (`node prisma/seed.js`).
Tables are created/synced by `prisma db push` on startup; run seed manually inside
the running containers when you need sample data.

Compose project name: `microandkafka` (passed via `-p`).

```bash
docker compose -p microandkafka exec product-service npm run seed
docker compose -p microandkafka exec shopping-service npm run seed
docker compose -p microandkafka exec user-service npm run seed
```

Seed sources: [user](services/user-service/prisma/seed.js) ·
[product](services/product-service/prisma/seed.js) ·
[shopping](services/shopping-service/prisma/seed.js).
