# Flow การทำงานของ WebSocket (live stock)

เอกสารนี้อธิบาย flow ของฟีเจอร์ **อัปเดต stock สินค้าแบบ real-time** ตั้งแต่ตอน
stock เปลี่ยนใน backend ไปจนถึงตัวเลขบนหน้าจอ browser ที่เปลี่ยนสดๆ โดยไม่ต้อง
refresh และเชื่อมโยงกลับมาที่โค้ดจริงของโปรเจกต์นี้

จุดสำคัญที่สุด: **WebSocket ไม่ได้ทำงานเดี่ยวๆ — มันต่อท้าย Kafka event ที่มีอยู่แล้ว**
gateway ทำหน้าที่เป็น "สะพาน" แปลง event จาก Kafka ให้เป็นข้อความ WebSocket แล้ว
กระจาย (fan-out) ไปทุก browser ที่เปิดค้างอยู่

---

## 1. คำศัพท์หลัก (Glossary)

| คำ | ความหมายสั้น ๆ |
|----|----------------|
| **WebSocket** | ช่องทางเชื่อมต่อ 2 ทาง (full-duplex) ที่เปิดค้างไว้ระหว่าง browser กับ server — server ส่งข้อมูลหา client ได้เองโดยไม่ต้องให้ client ถามก่อน (ต่างจาก HTTP request/response ปกติ) |
| **fan-out / broadcast** | การกระจายข้อความ 1 ก้อนไปยัง client หลายตัวพร้อมกัน |
| **Upgrade** | HTTP request พิเศษ (`Upgrade: websocket`) ที่ "ยกระดับ" connection จาก HTTP ธรรมดาให้กลายเป็น WebSocket |
| **heartbeat (ping/pong)** | กลไกเช็คว่า socket อีกฝั่งยังมีชีวิตอยู่ไหม — server ส่ง ping client ตอบ pong |
| **consumer group `gateway`** | gateway เข้าร่วม Kafka ในฐานะ consumer ของตัวเอง (group แยกจาก service อื่น) จึงมี offset ของตัวเอง ไม่ไปแย่งกับ shopping-service |
| **patch ใน place** | การแก้ค่าเฉพาะ field ที่เปลี่ยน (เช่น `stock`) ของ object เดิม โดยไม่ดึงข้อมูลใหม่ทั้งก้อน |

เพิ่มเติม
1. HTTP ปกติ browser ต้องเป็นฝ่ายถาม server ถึงจะตอบ (pull) — แต่ stock ที่เปลี่ยน
   เกิดจากคน**อื่น** checkout เราจึงไม่รู้จะถามตอนไหน WebSocket แก้ปัญหานี้เพราะ
   server **push** หาเราได้เองทันทีที่มีของใหม่
2. WebSocket แชร์ port เดียวกับ HTTP ของ gateway (`:8080`) ได้ เพราะมันเริ่มต้นด้วย
   HTTP request แล้วค่อย upgrade

---

## 2. ภาพใหญ่: ใครคุยกับใคร

```
   product-service                gateway (:8080)                browsers
  ┌───────────────┐          ┌──────────────────────┐       ┌──────────────┐
  │ stock เปลี่ยน  │          │  Kafka consumer       │       │   tab 1      │
  │ (checkout /   │  Kafka   │  group "gateway"      │  ws   │  หน้า list   │
  │  restock)     ├─────────►│       │               ├──────►│  /products   │
  │               │ topic:   │       ▼               │ /ws   ├──────────────┤
  │ publish()     │ product. │  broadcast() ─────────┤──────►│   tab 2      │
  │               │ stock.   │  (WebSocket server)   │       │  หน้า detail │
  └───────────────┘ changed  └──────────────────────┘       │ /products/5  │
                                                             └──────────────┘
         (ฝั่งซ้าย = ของเดิม ไม่แก้)   (ฝั่งกลาง = ของใหม่)    (ขวา = ของใหม่)
```

มี 2 ขา:
- **ขา Kafka (server → server)** — product-service publish event, gateway consume
- **ขา WebSocket (server → browser)** — gateway broadcast, browser ฟังแล้วอัปเดตจอ

> ทำไมวางที่ gateway? เพราะ browser คุยกับ gateway อยู่ที่เดียวอยู่แล้ว (single entry
> point) การเพิ่ม `/ws` ที่นี่จึงไม่ทำลายกติกา "browser แตะแค่ gateway" และไม่ต้อง
> สร้าง service ใหม่ ไม่ต้องเปิด port ใหม่

---

## 3. Flow เต็ม ทีละ step

```
 [1] คน A กด checkout
       │
       ▼
 [2] product-service ตัด stock ใน DB (commit) แล้ว publish
       │   topic "product.stock.changed"  { productId: 5, stock: 8 }
       ▼
 [3] Kafka เก็บ event ลง log (partition ตาม key = productId)
       │
       ▼
 [4] gateway (consumer group "gateway") อ่าน event ออกมา
       │   parse JSON → { productId: 5, stock: 8 }
       ▼
 [5] gateway broadcast ส่งให้ทุก browser ที่ต่อ /ws อยู่
       │   ส่ง JSON: { type:"product.stock.changed", productId:5, stock:8 }
       ▼
 [6] browser (คน B, C, D...) รับข้อความ
       │
       ▼
 [7] React patch state เฉพาะสินค้า id=5 → "8 in stock" เปลี่ยนทันที
```

### Step 2 — product-service publish (โค้ดเดิม ไม่แก้)

stock จะเปลี่ยนใน 2 จังหวะบน order path และ publish เหมือนกันทั้งคู่
([productController.js](../services/product-service/src/controllers/productController.js)):

```js
// ตอน checkout ตัด stock  /  ตอน order ถูกยกเลิกแล้วคืน stock
for (const r of updated) {
  await publish("product.stock.changed", { productId: r.id, stock: r.stock });
}
```

> publish **หลัง** DB commit เสมอ → ค่า stock ที่ส่งออกคือค่าจริงที่ลงฐานข้อมูลแล้ว

### Step 4 — gateway consume จาก Kafka

gateway สร้าง consumer ใน group ของตัวเอง subscribe เฉพาะ topic ที่สนใจ
([gateway/src/realtime.js](../gateway/src/realtime.js)):

```js
const consumer = kafka.consumer({ groupId: "gateway" });
await consumer.subscribe({ topic: "product.stock.changed", fromBeginning: false });
await consumer.run({
  eachMessage: async ({ message }) => {
    const payload = JSON.parse(message.value.toString());   // parse พัง = ข้าม ไม่ crash
    if (payload?.productId == null) return;
    broadcast({
      type: "product.stock.changed",
      productId: payload.productId,
      stock: payload.stock,
    });
  },
});
```

> เพราะเป็น group `"gateway"` แยกของตัวเอง → มี offset ของตัวเอง อ่าน event เดียวกัน
> ได้โดยไม่แย่งกับ shopping-service ที่ก็ consume `product.stock.changed` เหมือนกัน
> (ต่างคนต่างอ่านจาก commit log เดียวกัน)

### Step 5 — broadcast ออก WebSocket

วน loop ส่งให้ทุก client ที่ socket ยังเปิด:

```js
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}
```

WebSocket server เกาะอยู่บน HTTP server ตัวเดียวกับ gateway (แชร์ port 8080)
([gateway/src/index.js](../gateway/src/index.js)):

```js
const server = http.createServer(app);   // wrap Express
attachRealtime(server);                  // เพิ่ม /ws + Kafka consumer
server.listen(PORT, ...);
```

### Step 6–7 — browser ฟัง แล้ว patch จอ

hook `useStockSocket` เปิด WebSocket ตอนหน้าโหลด แปลง URL จาก `NEXT_PUBLIC_API_URL`
(`http://...` → `ws://...`) ([frontend/lib/useStockSocket.js](../frontend/lib/useStockSocket.js)):

```js
const ws = new WebSocket("ws://localhost:8080/ws");
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === "product.stock.changed") {
    cbRef.current?.({ productId: msg.productId, stock: msg.stock });
  }
};
```

หน้า list เอา callback ไป patch เฉพาะการ์ดใบที่เปลี่ยน
([frontend/app/page.js](../frontend/app/page.js)):

```js
useStockSocket(({ productId, stock }) => {
  setProducts((prev) =>
    prev.map((p) => (p.id === productId ? { ...p, stock } : p))
  );
});
```

> React re-render การ์ดใบเดียว ตัวเลข "X in stock" เปลี่ยนทันที — ไม่ยิง API ใหม่

---

## 4. Lifecycle ของ 1 connection

```
 browser                          gateway (/ws)
   │   GET /ws  (Upgrade: websocket)   │
   ├──────────────────────────────────►│   wss.on("connection")
   │   101 Switching Protocols          │   ws.isAlive = true
   │◄──────────────────────────────────┤
   │                                    │
   │   ===== เปิดค้างไว้ =====            │
   │                                    │
   │            ◄─── ping (ทุก 30 วิ) ───┤   heartbeat
   ├──── pong ─────────────────────────►│   ws.isAlive = true
   │                                    │
   │◄── ส่ง stock event (เมื่อมีของ) ─────┤   broadcast()
   │                                    │
   │   ปิด tab / เน็ตหลุด                 │
   ├──── close ────────────────────────►│   socket หลุดจาก wss.clients
   │                                    │
   │   (ฝั่ง client) onclose → ต่อใหม่ใน 2 วิ
```

---

## 5. การทนต่อความผิดพลาด (resilience)

| สถานการณ์ | เกิดอะไร | อยู่ที่ไหน |
|-----------|---------|-----------|
| browser ปิด tab / เน็ตหลุดเงียบ ๆ | gateway ping ทุก 30 วิ ถ้าไม่ตอบ pong → `terminate()` ทิ้ง ไม่ให้ socket ตายค้างกิน memory | [realtime.js](../gateway/src/realtime.js) `heartbeat` |
| WebSocket หลุดฝั่ง client | `onclose` → ตั้ง `setTimeout` ต่อใหม่ใน 2 วิ (auto-reconnect) | [useStockSocket.js](../frontend/lib/useStockSocket.js) |
| ต่อ Kafka ไม่ได้ตอน gateway start | catch แล้ว `setTimeout(attach, 3000)` retry เรื่อย ๆ — gateway ไม่ล่ม HTTP ยังใช้ได้ | [realtime.js](../gateway/src/realtime.js) `attach()` |
| message JSON พัง | `try/catch` รอบ `JSON.parse` → ข้าม message นั้น ไม่ crash ทั้งสองฝั่ง | ทั้ง gateway + frontend |
| callback เป็น inline function (เปลี่ยนทุก render) | เก็บ callback ใน `useRef` → socket ไม่ถูก tear down/สร้างใหม่ทุก render | [useStockSocket.js](../frontend/lib/useStockSocket.js) |

---

## 6. Config ที่เกี่ยวข้อง

gateway ต้องรู้จัก Kafka เพิ่ม ([docker-compose.yml](../docker-compose.yml)):

```yaml
gateway:
  environment:
    # live stock push: gateway consume product.stock.changed แล้ว fan-out ออก /ws
    KAFKA_BROKERS: kafka-1:29092,kafka-2:29092,kafka-3:29092
    KAFKA_CLIENT_ID: gateway
  depends_on:
    - kafka-1
    - kafka-2
    - kafka-3
```

dependency ใหม่ใน [gateway/package.json](../gateway/package.json):

| package | ใช้ทำอะไร |
|---------|-----------|
| `ws` | WebSocket server (เบา ตรงกับสไตล์ minimal ของ gateway) |
| `kafkajs` | Kafka consumer (version `^2.2.4` ตรงกับ service อื่น) |

---

## 7. ทำไม / ขอบเขต (scope)

**ทำไม event `product.stock.changed`?** เพราะมันคือ event ที่มีอยู่แล้วและสื่อ "stock
เปลี่ยน" ตรงตัวที่สุด product-service publish ทุกครั้งบน order path (ตัด stock ตอน
checkout, คืน stock ตอน order ถูกยกเลิก/rollback) → gateway ไม่ต้องแก้ product-service
สักบรรทัด

**ข้อจำกัดปัจจุบัน:** admin ที่แก้ stock เองผ่านหน้า admin จะออกเป็น event
`product.updated` (คนละ topic เพราะ payload มี name/price ปนมาด้วย) ซึ่งตอนนี้ยังไม่
วิ่งผ่าน `/ws` — ถ้าต้องการให้ admin แก้แล้ว push live ด้วย ทำได้โดยให้ gateway
subscribe `product.updated` เพิ่มแล้ว broadcast เฉพาะ field `stock`

**Demo:** เปิดหน้าร้าน 2 tab → ซื้อของใน tab แรก → ตัวเลข stock ใน tab ที่สองลดทันที
โดยไม่ต้อง refresh (และเพิ่มกลับถ้า order ถูกยกเลิก/คืน stock)

---

## 8. เทียบกับ pattern อื่นในโปรเจกต์

| วิธี push ข้อมูลหา browser | ข้อดี | ข้อเสีย | โปรเจกต์นี้ |
|---------------------------|-------|---------|-------------|
| **Polling** (browser ถาม API ทุก N วิ) | ง่ายสุด | ช้า (หน่วงตาม interval) + โหลด server เปล่า ๆ | ไม่ใช้ |
| **WebSocket** | real-time จริง, 2 ทาง, server push ได้ | ต้องดูแล connection/heartbeat | **ใช้ (ฟีเจอร์นี้)** |
| **SSE** (Server-Sent Events) | push ทางเดียว ง่ายกว่า WS | ทางเดียว, มี limit จำนวน connection ต่อ browser | ไม่ใช้ |

> ดู flow ฝั่ง Kafka แบบละเอียด (cluster / partition / offset) ได้ที่
> [kafka-structure.md](./kafka-structure.md)
