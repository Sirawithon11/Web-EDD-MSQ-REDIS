# Flow การทำงานของ gRPC (การติดต่อระหว่าง service)

เอกสารนี้อธิบายว่า service ต่าง ๆ ในโปรเจกต์นี้ **คุยกันด้วย gRPC ทั้งหมด** อย่างไร
ตั้งแต่ browser ยิง REST เข้ามาที่ gateway ไปจนถึง service ตอบกลับ และเชื่อมโยงกลับ
มาที่โค้ดจริงของโปรเจกต์

จุดสำคัญที่สุด: **browser ยังคุย REST เหมือนเดิม** — gateway เป็น "ล่าม" แปลง REST
ของ browser ให้กลายเป็น gRPC call ไปหา service ข้างหลัง ส่วน service-to-service
(shopping → product ตอน checkout) ก็เป็น gRPC เช่นกัน HTTP ที่เหลืออยู่ในระบบหลังบ้าน
มีแค่ "ขอบนอก" ของ gateway (REST + WebSocket) ที่ browser แตะเท่านั้น

---

## 1. คำศัพท์หลัก (Glossary)

| คำ | ความหมายสั้น ๆ |
|----|----------------|
| **gRPC** | กรอบการเรียกฟังก์ชันข้ามเครื่อง (RPC) ของ Google วิ่งบน HTTP/2 ส่งข้อมูลเป็น binary (Protobuf) เร็วและรัดกุมกว่า REST/JSON |
| **Protocol Buffers (.proto)** | ภาษากลางสำหรับนิยาม "สัญญา" (contract) — มี service ไหน, method ไหน, รับ/ส่ง message หน้าตาอย่างไร |
| **RPC method** | ฟังก์ชันที่เรียกข้ามเครื่องได้ เช่น `ProductService.DecrementStock` — ฝั่ง client เรียกเหมือนเรียกฟังก์ชันปกติ แต่จริง ๆ วิ่งข้าม network |
| **stub / client** | object ฝั่งผู้เรียกที่ "หน้าตาเหมือน service" — เรียก `client.List(...)` แล้ว gRPC จัดการ serialize + ส่งให้เอง |
| **metadata** | key/value แนบไปกับ request/response (คล้าย HTTP header) — เราใช้ส่ง JWT (`authorization`) และ `x-cache` |
| **status code** | รหัสผลลัพธ์ของ gRPC (เช่น `NOT_FOUND`, `PERMISSION_DENIED`) — คนละชุดกับ HTTP status ต้อง map กัน |
| **unary call** | การเรียกแบบ 1 request → 1 response (แบบที่โปรเจกต์นี้ใช้ทั้งหมด) ไม่ใช่ streaming |
| **REST → gRPC translation** | gateway รับ REST จาก browser แล้วแปลงเป็น gRPC call ต่อให้ service |

เพิ่มเติม
1. **ทำไม gRPC ดีกว่า REST สำหรับ service-to-service?** สัญญาชัด (proto เป็นเอกสาร
   ในตัว), payload เล็ก/เร็ว (binary), HTTP/2 reuse connection เดียวได้หลาย call
2. **ทำไม browser ยังใช้ REST?** browser เรียก gRPC ตรง ๆ ไม่ได้ (ต้องมี gRPC-Web +
   proxy) จึงให้ gateway เป็นด่านแปลง REST↔gRPC — frontend ไม่ต้องแก้อะไรเลย

---

## 2. ภาพใหญ่: ใครคุยกับใคร

```
   browser                gateway (:8080)              services (gRPC)
  ┌──────────┐         ┌──────────────────┐        ┌────────────────────┐
  │ Next.js  │  REST   │  Express routes   │  gRPC  │ user-service :50051│
  │ fetch()  ├────────►│  + gRPC clients   ├───────►│ product-svc  :50052│
  │          │  /api/* │  (ล่าม REST→gRPC)  │        │ shopping-svc :50053│
  │          │◄────────┤                   │◄───────┤                    │
  └──────────┘  JSON   └──────────────────┘        └─────────┬──────────┘
       ▲          (แปลง gRPC status→HTTP)                     │ gRPC
       │ WebSocket /ws (live stock — คนละขา ดู websocket-flow.md)
       │                                          shopping ──┘
       └─ ยังเป็น REST/WS ทั้งหมด          (checkout: shopping → product)
```

มี 3 ขาในการสื่อสารแบบ request/response:

- **ขา REST (browser → gateway)** — ของเดิม ไม่แก้ frontend ยิง `fetch("/api/...")`
- **ขา gRPC (gateway → service)** — gateway แปลง REST เป็น gRPC call ไปหา 3 service
- **ขา gRPC (service → service)** — shopping เรียก product ตอน checkout (saga ตัด stock)

> นอกจากนี้ยังมี **ขา Kafka (async event)** ที่ไม่เกี่ยวกับเอกสารนี้ — ดู
> [kafka-structure.md](./kafka-structure.md) และ **ขา WebSocket** สำหรับ live stock —
> ดู [websocket-flow.md](./websocket-flow.md)

---

## 3. สัญญา (contract) อยู่ที่ไหน — ไฟล์ `.proto`

แต่ละ service มีไฟล์ proto ของตัวเองใน `proto/` และ gateway เก็บสำเนาทั้งสามไว้เป็น
ฝั่ง client (เพราะ Docker build context แยกกันต่อ service):

| ไฟล์ | นิยาม service | ใครโหลด |
|------|---------------|---------|
| [product.proto](../services/product-service/proto/product.proto) | `ProductService` | product-service (server), shopping + gateway (client) |
| [user.proto](../services/user-service/proto/user.proto) | `UserService` | user-service (server), gateway (client) |
| [shopping.proto](../services/shopping-service/proto/shopping.proto) | `ShoppingService` | shopping-service (server), gateway (client) |

### การโมเดล message แบบ Hybrid

โปรเจกต์นี้เลือกผสม 2 แบบ เพื่อได้ทั้ง type safety ตรงที่จำเป็น และคง REST contract เดิม:

```proto
service ProductService {
  // --- ฝั่ง gateway: ส่ง JSON ใน string field (คง REST shape เป๊ะ) ---
  rpc List(JsonQuery) returns (JsonReply);        // GET /products
  rpc Create(JsonBody) returns (JsonReply);       // POST /products
  rpc Remove(IdRequest) returns (Empty);          // DELETE /products/:id

  // --- ฝั่ง internal: typed protobuf เต็มรูปแบบ (สัญญา service-to-service จริง) ---
  rpc BulkByIds(IdList) returns (ProductList);
  rpc DecrementStock(StockChangeRequest) returns (StockChangeReply);
  rpc Restock(StockChangeRequest) returns (StockChangeReply);
}

message JsonReply { string json = 1; }   // body แบบ passthrough JSON
message Product {                          // typed message ของจริง
  int32 id = 1; string name = 2; double price = 3; int32 stock = 4; bool active = 5;
}
```

| แบบ | ใช้กับ | เหตุผล |
|-----|--------|--------|
| **Typed protobuf** | `BulkByIds` / `DecrementStock` / `Restock` (shopping→product) | เป็น contract east-west ของจริงบน checkout path — ได้ type safety + 409/404 ชัดเจน |
| **JSON ใน `string` field** | endpoint ฝั่ง gateway (list/admin/analytics/audit/CRUD) | shape ซับซ้อน/ไดนามิก (audit `details`, category ซ้อน, analytics) — ห่อ JSON ไว้ทำให้ REST ที่ browser เห็น **เหมือนเดิมทุก byte** ไม่ต้องแก้ frontend |

---

## 4. Flow A — browser → gateway → service (เช่น GET /api/products)

```
 [1] browser: fetch("/api/products?page=1&limit=12")
       │  (REST GET)
       ▼
 [2] gateway route: app.get("/api/products", ...) 
       │  แปลง query เป็น JSON string → { query: '{"page":"1","limit":"12"}' }
       │  แนบ JWT จาก header ใส่ gRPC metadata "authorization"
       ▼
 [3] gateway เรียก  productClient.List(request, metadata, cb)   ── gRPC ──►
       ▼
 [4] product-service: handler List(call)
       │  parse JSON query → query Prisma (+ cache-aside Redis)
       │  ตอบ { json: "<JSON ของ {data, pagination}>" }
       │  แนบ trailing metadata  x-cache: HIT|MISS
       ◄── gRPC reply ──
 [5] gateway: forward()
       │  JSON.parse(reply.json) → ตั้ง header X-Cache จาก trailing metadata
       │  res.status(200).json(...)
       ▼
 [6] browser ได้ JSON เดิมเป๊ะ (เหมือนตอนยังเป็น REST proxy)
```

### Step 2–3 — gateway แปลง REST เป็น gRPC

([gateway/src/index.js](../gateway/src/index.js)):

```js
app.get("/api/products", (req, res) =>
  forward(req, res, productClient, "List", { query: JSON.stringify(req.query) })
);
```

`forward()` ทำงานหนักอยู่ใน [gateway/src/grpcClients.js](../gateway/src/grpcClients.js):
สร้าง metadata จาก JWT, เรียก gRPC, map error, คง X-Cache, คง success code (201/204)

```js
function metaFrom(req) {
  const md = new grpc.Metadata();
  if (req.headers.authorization) md.set("authorization", req.headers.authorization);
  return md;
}
```

### Step 4 — service ตอบ (handler)

([services/product-service/src/grpc/handlers.js](../services/product-service/src/grpc/handlers.js)):

```js
List: handler(async (call) => {
  const { search, page = "1", limit = "12", sort = "newest" } =
    JSON.parse(call.request.query || "{}");
  // ... query Prisma + cache-aside เหมือน controller เดิม ...
  const cached = await getJSON(key);
  if (cached) return { value: reply(cached), trailer: cacheTrailer("HIT") };
  // ...
  return { value: reply(result), trailer: cacheTrailer("MISS") };
})
```

> `reply(obj)` = `{ json: JSON.stringify(obj) }` — ห่อ object เป็น JSON string
> ตาม contract แบบ hybrid

---

## 5. Flow B — service → service (checkout: shopping → product)

นี่คือ "ขา east-west" ของจริง — เป็น **typed gRPC** และเป็นหัวใจของ saga ตัด stock

```
 [1] browser: POST /api/orders  (checkout)
       ▼
 [2] gateway → shoppingClient.Checkout({}, metadata)   ── gRPC ──►
       ▼
 [3] shopping-service: handler Checkout(call)
       │  โหลด cart → ต้องรู้ราคา/ชื่อสินค้า + ต้องจอง stock
       │
       ├──► productClient.getProductsByIds(ids)      ── gRPC ──► product (BulkByIds)
       │        คืน typed Product[] (id, name, price, stock, active)
       │
       ├──► productClient.decrementStock(items)      ── gRPC ──► product (DecrementStock)
       │        ตัด stock แบบ atomic ใน transaction
       │        ของไม่พอ → throw FAILED_PRECONDITION
       │
       ▼
 [4] shopping สร้าง Order ใน DB (transaction)
       │   ถ้า DB พังหลังตัด stock แล้ว → productClient.restock(items)  (saga rollback)
       ▼
 [5] publish "order.placed" → Kafka (async, ไม่อยู่บน critical path)
       ▼
 [6] ตอบ order กลับ gateway → browser (201 Created)
```

### typed contract + การ map error กลับเป็น HTTP

ฝั่ง client ([services/shopping-service/src/productClient.js](../services/shopping-service/src/productClient.js))
แปลง gRPC status กลับเป็น `.status` แบบ HTTP เดิม เพื่อให้ logic checkout ไม่ต้องแก้:

```js
async function decrementStock(items) {
  try {
    return await unary("DecrementStock", {
      items: items.map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity) })),
    });
  } catch (err) {
    const mapped = new Error(err.details || err.message);
    mapped.status =
      err.code === grpc.status.FAILED_PRECONDITION ? 409 :  // ของไม่พอ
      err.code === grpc.status.NOT_FOUND          ? 404 :  // สินค้าหาย
      502;
    throw mapped;
  }
}
```

ฝั่ง server โยน gRPC status ที่ถูกต้อง
([services/product-service/src/grpc/handlers.js](../services/product-service/src/grpc/handlers.js)):

```js
if (product.stock < qty) {
  throw { code: "INSUFFICIENT", name: product.name, available: product.stock, requested: qty };
}
// ...ถูก catch แล้วแปลงเป็น...
throw rpcError(grpc.status.FAILED_PRECONDITION, `Insufficient stock for "${err.name}" ...`);
```

> **ทำไมต้อง typed ตรงนี้?** เพราะ shopping ต้องอ่าน `price`, `name`, `stock` ของสินค้า
> โดยตรง และต้องแยกให้ออกว่า "ของไม่พอ (409)" กับ "สินค้าหาย (404)" — สัญญาที่
> strict ช่วยให้ทั้งสองฝั่งไม่หลุด

---

## 6. Auth — JWT เดินทางใน metadata

ไม่มี body ไหนแบก token — JWT เดินทางใน gRPC metadata `authorization` แทน HTTP header
แล้วทุก service **verify ซ้ำเอง** (defense in depth เหมือนตอนเป็น middleware)

```
 browser ──(Header: Authorization: Bearer xxx)──► gateway
   gateway ──(metadata: authorization=Bearer xxx)──► service
     service: jwt.verify(token) → req.user → เช็ค role
```

([services/*/src/grpc/auth.js](../services/product-service/src/grpc/auth.js)):

```js
function getUser(call) {
  const md = call.metadata.get("authorization");
  const token = String(md?.[0] || "").startsWith("Bearer ") ? md[0].slice(7) : null;
  return token ? jwt.verify(token, process.env.JWT_SECRET) : null;
}
function requireAdmin(call) {
  const user = requireAuth(call);                       // ไม่มี token → UNAUTHENTICATED
  if (user.role !== "ADMIN") throw rpcError(grpc.status.PERMISSION_DENIED, "...");
  return user;
}
```

gateway ยัง fast-fail JWT ที่ `/api/cart` และ `/api/orders` (ตัดทิ้งเร็วก่อนยิง gRPC)
แต่ service ก็ยังเช็คเองอยู่ดี — ปลอดภัยแม้มีคนยิง gRPC ตรงเข้า service

---

## 7. การ map gRPC status → HTTP status

gateway แปลงรหัส gRPC กลับเป็น HTTP ที่ browser คุ้นเคย
([gateway/src/grpcClients.js](../gateway/src/grpcClients.js)):

| gRPC status | HTTP | ใช้ตอนไหน |
|-------------|------|-----------|
| `INVALID_ARGUMENT` | 400 | input ไม่ครบ/ผิด |
| `UNAUTHENTICATED` | 401 | ไม่มี/token เสีย |
| `PERMISSION_DENIED` | 403 | ไม่ใช่ admin |
| `NOT_FOUND` | 404 | หา resource ไม่เจอ |
| `ALREADY_EXISTS` | 409 | email ซ้ำ (register) |
| `FAILED_PRECONDITION` | 409 | stock ไม่พอ (checkout) |
| `UNAVAILABLE` | 503 | service ปลายทางล่ม |
| อื่น ๆ | 500 | error ไม่คาดคิด |

```js
const STATUS_MAP = {
  [grpc.status.NOT_FOUND]: 404,
  [grpc.status.FAILED_PRECONDITION]: 409,
  // ...
};
function sendError(res, err) {
  res.status(STATUS_MAP[err.code] || 500).json({ message: err.details || err.message });
}
```

---

## 8. X-Cache เดินทางอย่างไร (trailing metadata)

cache-aside (Redis) ยังอยู่ครบ และ header `X-Cache: HIT|MISS` ยังโผล่ที่ browser
เหมือนเดิม — แต่ตอนนี้เดินทางผ่าน **trailing metadata** ของ gRPC

```
 service handler:  callback(null, reply, trailerMetadata{x-cache: "MISS"})
        │
        ▼  (gRPC ส่ง trailing metadata มาตอนจบ call)
 gateway unary(): ดัก event "status" (ยิงหลัง response) → เก็บ trailers
        │
        ▼
 gateway forward(): res.setHeader("X-Cache", trailers.get("x-cache")[0])
```

> จุดที่ต้องระวัง: callback ของ unary ยิง **ก่อน** event `status` ที่แบก trailing
> metadata เราจึงต้อง resolve promise ตอน `status` ไม่ใช่ตอน callback ([grpcClients.js](../gateway/src/grpcClients.js) ฟังก์ชัน `unary`)

```js
function unary(client, method, request, md) {
  return new Promise((resolve, reject) => {
    let response, error;
    const call = client[method](request, md, (err, res) => { err ? (error = err) : (response = res); });
    call.on("status", (status) => {                 // ยิงทีหลัง + แบก trailing metadata
      error ? reject(error) : resolve({ response, trailers: status.metadata });
    });
  });
}
```

---

## 9. การบูตระบบ — service เป็น gRPC ล้วน

service ไม่มี Express/HTTP แล้ว เหลือแค่ gRPC server + Kafka consumer
([services/product-service/src/index.js](../services/product-service/src/index.js)):

```js
async function main() {
  startGrpcServer();                 // bind gRPC ที่ GRPC_PORT
  await connectBus();                // Kafka เดิม ไม่แก้
  startConsumer({ groupId: "product-service", topics: [...], handlers });
}
```

([services/product-service/src/grpc/server.js](../services/product-service/src/grpc/server.js)):

```js
const server = new grpc.Server({ "grpc.max_receive_message_length": 16*1024*1024, ... });
server.addService(proto.ProductService.service, handlers);
server.bindAsync(`0.0.0.0:${process.env.GRPC_PORT || 50052}`,
  grpc.ServerCredentials.createInsecure(), (err, port) => { ... });
```

> ตั้ง max message 16MB เพราะรูปสินค้าเป็น base64 data-URL อาจใหญ่ (เดิม Express
> ตั้ง limit 8MB)

---

## 10. การทนต่อความผิดพลาด (resilience)

| สถานการณ์ | เกิดอะไร | อยู่ที่ไหน |
|-----------|---------|-----------|
| product-service ล่มตอน shopping เรียก | gRPC error → `decrementStock` โยน `.status = 502`; checkout ตอบ `UNAVAILABLE` → gateway map 503 | [productClient.js](../services/shopping-service/src/productClient.js) |
| stock ไม่พอ | `FAILED_PRECONDITION` → 409 ไม่มีการตัด stock เลย (atomic ใน transaction) | [product handlers](../services/product-service/src/grpc/handlers.js) |
| Order DB พังหลังตัด stock | `restock()` คืน stock (best-effort, ไม่ throw) — saga rollback | [shopping handlers](../services/shopping-service/src/grpc/handlers.js) `Checkout` |
| ไม่มี/token เสีย | service โยน `UNAUTHENTICATED`/`PERMISSION_DENIED` → 401/403 (gateway ยัง fast-fail ด้วย) | [grpc/auth.js](../services/shopping-service/src/grpc/auth.js) |
| error ไม่คาดคิดใน handler | `handler()` wrapper จับ → log + ตอบ `INTERNAL` (500) ไม่ให้ call ค้าง | ทุก `grpc/handlers.js` |

---

## 11. Config ที่เกี่ยวข้อง

([docker-compose.yml](../docker-compose.yml)) — service เปิด gRPC port, gateway/shopping
รู้ปลายทางผ่าน `*_GRPC_ADDR`:

```yaml
product-service:
  environment:
    GRPC_PORT: 50052
  ports: ["50052:50052"]

shopping-service:
  environment:
    GRPC_PORT: 50053
    PRODUCT_GRPC_ADDR: product-service:50052   # เรียก product ตอน checkout

gateway:
  environment:
    USER_GRPC_ADDR: user-service:50051
    PRODUCT_GRPC_ADDR: product-service:50052
    SHOPPING_GRPC_ADDR: shopping-service:50053
```

dependency ใหม่ (ทั้ง 3 service + gateway):

| package | ใช้ทำอะไร |
|---------|-----------|
| `@grpc/grpc-js` | gRPC runtime (server + client) เป็น pure-JS ไม่ต้อง compile native |
| `@grpc/proto-loader` | โหลด `.proto` ตอน runtime (ไม่ต้อง codegen ล่วงหน้า) |

> gateway ถอด `http-proxy-middleware` ออก (ไม่ proxy แล้ว) แต่ยังใช้ Express สำหรับ
> รับ REST + WebSocket `/ws`

---

## 12. ทำไม / ขอบเขต (scope)

**ทำไมแปลงเป็น gRPC?** ให้การสื่อสารระหว่าง service มีสัญญาที่ชัด (proto เป็นเอกสาร
ในตัว), payload เล็ก/เร็วกว่า JSON, และ HTTP/2 ใช้ connection เดียวยิงได้หลาย call

**ทำไมไม่แปลง browser → gateway ด้วย?** browser เรียก gRPC ตรงไม่ได้ (ต้อง gRPC-Web)
การให้ gateway เป็นล่าม REST↔gRPC ทำให้ **frontend ไม่ต้องแก้แม้แต่บรรทัดเดียว** และ
ยังเปิด WebSocket `/ws` ที่เดิมได้

**endpoint ภายในที่หายจาก gateway:** `bulk` / `decrement-stock` / `restock` เดิมโผล่
ผ่าน gateway (เพราะ proxy จับ `/api/products/*` ทั้งหมด) ตอนนี้เป็น **gRPC-internal
เท่านั้น** (shopping เรียก product โดยตรง) ไม่เปิดออกที่ gateway — สะอาดกว่าเพราะมัน
คือ contract ภายในจริง ๆ

**ขอบเขตที่ยังเหมือนเดิม:** Kafka (async event), Redis (cache-aside), WebSocket
(live stock), saga ตัด/คืน stock — โครงสร้างทั้งหมดไม่เปลี่ยน เปลี่ยนแค่ "ท่อ" sync
จาก HTTP เป็น gRPC

---

## 13. เทียบ REST proxy (เดิม) vs gRPC (ปัจจุบัน)

| ประเด็น | REST proxy (เดิม) | gRPC (ปัจจุบัน) |
|---------|-------------------|----------------|
| gateway → service | `http-proxy-middleware` ส่ง HTTP ต่อตรง ๆ | แปลง REST → gRPC call แล้ว map ผลกลับ |
| สัญญา (contract) | อยู่ในโค้ด route/controller กระจาย | รวมศูนย์ใน `.proto` ชัดเจน |
| service ฟัง | Express HTTP (:4001/2/3) | gRPC server (:50051/2/3) ไม่มี HTTP |
| auth | JWT ใน HTTP header | JWT ใน gRPC metadata |
| error | HTTP status ตรง ๆ | gRPC status → map เป็น HTTP ที่ gateway |
| browser | REST (ไม่แก้) | REST (ไม่แก้) |

> ดูภาพรวมสถาปัตยกรรมทั้งหมดได้ที่ [../ARCHITECTURE.md](../ARCHITECTURE.md) ·
> ดู event/Kafka ที่ [kafka-structure.md](./kafka-structure.md) ·
> ดู WebSocket ที่ [websocket-flow.md](./websocket-flow.md)
