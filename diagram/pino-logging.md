# การเก็บ Log ด้วย Pino และผลต่อการ Search ใน Elasticsearch

เอกสารนี้อธิบายว่าทำไมโปรเจกต์นี้เปลี่ยนจาก `console.log` มาใช้ **pino** ในการเก็บ
log ของ "ทุก event" (ทั้งฝั่ง publish, consume, retry, DLQ และ WebSocket broadcast)
และที่สำคัญที่สุดคือ **structured log (JSON) มีผลต่อการ search ใน Elasticsearch
อย่างไร** เมื่อเทียบกับ log แบบข้อความธรรมดา

จุดสำคัญที่สุด: **pino ไม่ได้แค่ทำให้ log สวยขึ้น — มันเปลี่ยน log จาก "ข้อความ 1 ก้อน"
ให้กลายเป็น "field ที่ค้นหาได้ทีละช่อง"** ซึ่งเป็นเงื่อนไขที่ทำให้ Elasticsearch/Kibana
filter, aggregate และทำ dashboard ได้จริง

---

## 1. ตัวอย่าง flow ของ 1 event: `order.placed`

ขอเล่าผ่าน event เดียวให้เห็นภาพ ตั้งแต่ลูกค้ากดสั่งซื้อ จนกลายเป็น log ที่ค้นใน
Kibana ได้ — event นี้คือ `order.placed` ที่ **shopping-service เป็นคน publish** และ
**product-service เป็นคน consume** เพื่อไปบวก `salesCount` ของสินค้าแต่ละชิ้น

```
ลูกค้ากด checkout
      │ HTTP
      ▼
┌──────────────────────────────┐
│ shopping-service             │  1) สร้าง order ใน DB แล้ว commit
│ controllers/orderController  │  2) publish("order.placed", {orderId,userId,total,items})
│   └─ events/bus.publish()    │     → pino เขียน log: "event published"   ◄── log #1
└──────────────┬───────────────┘
               │ Kafka topic: "order.placed"  (key = userId → เลือก partition)
               ▼
┌──────────────────────────────┐
│ product-service             │  3) consume (consumer group "product-service")
│ events/bus.startConsumer()  │  4) parse payload → เรียก handler["order.placed"]
│ events/handlers.js          │     handler บวก salesCount ของแต่ละ item
│                              │     สำเร็จ → pino เขียน log: "event handled"  ◄── log #2
└──────────────┬───────────────┘     (ถ้า DB สะดุด → "handler failed; retrying"
               │                       ครบ 3 ครั้งยังพัง → "handler gave up -> DLQ")
               │ stdout (JSON 1 บรรทัด/1 log)
               ▼
       Filebeat → Logstash → Elasticsearch → Kibana  (ค้นได้ทีละ field)
```

จุดที่ต้องเข้าใจ:

1. **publish เกิดหลัง DB commit** (`orderController.js`) — ดู log #1 จะรู้ทันทีว่า
   event ถูกยิงออกจาก shopping-service สำเร็จเมื่อไหร่
2. **key ของ event นี้คือ `userId`** ไม่ใช่ orderId — เพราะ `bus.publish()` เลือก key
   จาก `payload.id ?? payload.productId ?? payload.userId` ส่วน payload ของ
   `order.placed` มีแต่ `orderId/userId/total/items` (ไม่มี `id`) จึงตกมาที่ `userId`
3. **คนละ service = คนละค่า `service` ใน log** — log #1 เป็น `shopping-service`,
   log #2 เป็น `product-service` แต่ทั้งคู่มี `messageId` เดียวกัน จึง trace event
   ก้อนเดิมข้าม service ได้ (ดูข้อ 2)

---

## 2. log ที่ pino เขียนออกมาในแต่ละ step

ทุก step ข้างบนกลายเป็น JSON บรรทัดเดียวออก stdout — นี่คือหน้าตาจริง (ค่าตัวอย่าง):

**log #1 — shopping-service ยิง event ออก** (หลัง commit ใน `orderController`):

```json
{"level":30,"time":1782120000001,"service":"shopping-service","component":"bus","event":"order.placed","key":"42","msg":"event published"}
```

**log #2 — product-service consume + handle สำเร็จ** (เพิ่ม salesCount เสร็จ):

```json
{"level":30,"time":1782120000150,"service":"product-service","component":"bus","event":"order.placed","topic":"order.placed","partition":2,"offset":"57","key":"42","messageId":"9f3c1d20-...","msg":"event handled"}
```

> `key:"42"` คือ `userId` ของลูกค้า · `messageId` ก้อนเดียวกันนี้แนบมากับ event ตั้งแต่
> ตอน publish จึงใช้ตามรอย event เดิมข้าม service ได้

**ถ้า handler พังชั่วคราว** (เช่น DB สะดุด) จะเห็น log เพิ่มอีกชุด — retry ก่อน แล้ว
ถึงยอมแพ้ส่งเข้า DLQ:

```json
{"level":40,"time":1782120000160,"service":"product-service","component":"bus","event":"order.placed","topic":"order.placed","partition":2,"offset":"57","key":"42","messageId":"9f3c1d20-...","attempt":1,"maxRetries":3,"backoff":300,"err":"connect ECONNREFUSED","msg":"handler failed; retrying"}
{"level":50,"time":1782120001100,"service":"product-service","component":"bus","event":"order.placed","topic":"order.placed","partition":2,"offset":"57","key":"42","messageId":"9f3c1d20-...","attempts":3,"err":"connect ECONNREFUSED","msg":"handler gave up -> DLQ"}
```

> `level`: `30`=info, `40`=warn, `50`=error · `time`: epoch milliseconds ·
> สังเกตว่า `partition`/`offset`/`messageId` เหมือนกันทั้งสามบรรทัด เพราะเป็น event
> ก้อนเดียวกันที่ถูกพยายาม handle ซ้ำ

หัวข้อถัด ๆ ไปจะลงรายละเอียดว่า log พวกนี้ถูกประกอบขึ้นจากโค้ดส่วนไหน (ข้อ 3–4) และ
ทำไม "การเป็น field แยก" ถึงทำให้ค้นใน Elasticsearch ได้ดีกว่า `console.log` เดิม (ข้อ 5)

---

## 3. โครงสร้างโค้ดฝั่ง pino

### 3.1 logger กลางของแต่ละ process

แต่ละ service/gateway มีไฟล์ `logger.js` ของตัวเอง (เพราะเป็นคนละ process คนละ
`package.json` ไม่มี shared package):

- `gateway/src/logger.js`
- `services/product-service/src/logger.js`
- `services/shopping-service/src/logger.js`
- `services/user-service/src/logger.js`

หัวใจของไฟล์:

```js
const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: process.env.SERVICE_NAME || "product-service" },
  ...(process.env.LOG_PRETTY === "1"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } }
    : {}),
});

module.exports = logger;
```

3 จุดที่ตั้งใจออกแบบ:

1. **`base: { service }`** — ทุกบรรทัด log จะมี field `service` ติดไปเสมอ ทำให้
   แยกได้ว่า log มาจาก service ไหน (สำคัญมากตอนรวม log หลาย service ใน ES index
   เดียวกัน) — การกำหนด `base` เองยังตัด `pid`/`hostname` default ของ pino ออก
   เพื่อให้บรรทัดสะอาด
2. **`level` จาก env** — ปรับ verbosity ได้โดยไม่แก้โค้ด (`LOG_LEVEL=debug`)
3. **`pino-pretty` เฉพาะตอน dev** — ตั้ง `LOG_PRETTY=1` จะได้ log สีอ่านง่าย
   ส่วน production ปล่อยเป็น JSON ดิบเพื่อให้ ELK กินต่อได้ตรง ๆ

### 3.2 child logger ต่อ component

ในแต่ละไฟล์ที่ใช้งานจะสร้าง child logger ติด field `component`:

```js
// services/*/src/events/bus.js
const log = require("../logger").child({ component: "bus" });

// gateway/src/realtime.js
const log = require("./logger").child({ component: "realtime" });
```

ผลคือทุก log จาก bus จะมี `"component":"bus"` ติดไปอัตโนมัติ — กรองเฉพาะ log ของ
ระบบ event ได้ในคลิกเดียว

---

## 4. log "ทุก event" ที่ถูกเก็บ

ทุกจุดในเส้นทาง event ถูกแทน `console.*` เดิมด้วย structured log แล้ว

### 4.1 ฝั่ง event bus (`services/*/src/events/bus.js`)

ตอน consume ทุกข้อความจะสร้าง `meta` ก้อนเดียวแล้วแนบไปทุก log ที่เกี่ยวกับ
ข้อความนั้น:

```js
const meta = { event: type, topic, partition, offset: message.offset, key: ..., messageId };
```

| สถานการณ์ | level | ข้อความ (`msg`) | field เด่น |
|-----------|-------|-----------------|-----------|
| producer ต่อ Kafka สำเร็จ | info | `producer connected` | `brokers` |
| producer ต่อไม่ได้ | error | `producer connect failed; retrying` | `err`, `retryMs` |
| publish event สำเร็จ | info | `event published` | `event`, `key` |
| consumer พร้อมทำงาน | info | `consumer running` | `groupId`, `topics` |
| consume + handle สำเร็จ | info | `event handled` | `meta` ทั้งก้อน |
| parse payload พัง → DLQ | error | `event parse failed -> DLQ` | `meta`, `err` |
| handler พังแล้ว retry | warn | `handler failed; retrying` | `attempt`, `backoff`, `err` |
| handler ยอมแพ้ → DLQ | error | `handler gave up -> DLQ` | `attempts`, `err` |
| consumer attach ไม่ได้ | error | `consumer attach failed; retrying` | `groupId`, `err` |

### 4.2 ฝั่ง WebSocket (`gateway/src/realtime.js`)

| สถานการณ์ | level | ข้อความ | field เด่น |
|-----------|-------|---------|-----------|
| broadcast stock ออกทุก client | info | `stock change broadcast` | `productId`, `stock`, `clients` |
| ข้อความ parse ไม่ได้ | warn | `skipping unparseable event` | `offset`, `err` |
| consumer พร้อม push เข้า `/ws` | info | `consumer running -> WebSocket /ws` | `topic` |

> `clients` = จำนวน socket ที่ข้อความไปถึงจริง (ฟังก์ชัน `broadcast()` ถูกแก้ให้
> คืนค่าจำนวนนี้) — ใช้ดูได้ว่าตอนนั้นมีกี่ tab เปิดอยู่

### 4.3 หน้าตา log จริง

**เดิม (`console.log`)** — เป็นประโยคเดียว:

```
[bus] handler "order.placed" gave up after 3 attempt(s) -> DLQ: connect ECONNREFUSED
```

**ใหม่ (pino, JSON)** — แตกเป็น field:

```json
{"level":50,"time":1782120487203,"service":"product-service","component":"bus","event":"order.placed","topic":"order.placed","partition":1,"offset":"42","key":"7","messageId":"a1b2...","attempts":3,"err":"connect ECONNREFUSED","msg":"handler gave up -> DLQ"}
```

> `level`: `30`=info, `40`=warn, `50`=error · `time`: epoch milliseconds

---

## 5. ผลต่อการ Search ใน Elasticsearch (หัวใจของเอกสารนี้)

### 5.1 ปัญหาของ log แบบข้อความ (`console.log`)

เมื่อ log เป็นประโยคเดียว Elasticsearch จะเห็นมันเป็น field เดียวชื่อ `message`
ที่มีค่าเป็น string ยาว ๆ ผลคือ:

- จะหา "DLQ ทั้งหมดของ product-service" ต้องใช้ **full-text match** กับคำว่า
  `DLQ` ซึ่งจับ log อื่นที่บังเอิญมีคำนี้ติดมาด้วย
- จะดึง `offset`, `partition`, `attempts` ออกมา ต้องเขียน **grok regex** ใน
  Logstash แกะประโยค — พอข้อความเปลี่ยนคำเดียว regex พังทั้งแถบ
- ทำ **aggregation** (เช่น นับ DLQ ต่อ event type) แทบไม่ได้ เพราะค่าไม่ได้
  อยู่ในรูป field ที่ ES รวมยอดได้

### 5.2 ข้อดีของ structured log (pino) ใน ES

เพราะ pino ส่ง JSON ออกมาแล้ว Filebeat/Logstash แค่ **decode JSON** (ไม่ต้อง grok)
ทุก key จะกลายเป็น **field ของ document ใน ES** โดยตรง → ได้ field mapping ฟรี:

| field | ชนิดที่ ES มัก map ให้ | ค้นหาแบบ |
|-------|----------------------|----------|
| `service`, `component`, `event`, `msg` | `keyword` (+ `text`) | term/exact + full-text |
| `level`, `partition`, `attempts`, `clients` | `long` | range / เปรียบเทียบ / aggregate |
| `offset` | `keyword` (เป็น string) | term |
| `time` | `date` (ถ้า map เป็น date) | range เวลา / timeline |
| `err` | `text`/`keyword` | ค้นข้อความ error |

### 5.3 ตัวอย่าง query ที่ "ทำได้เพราะมี field" (Kibana KQL)

```text
# 1) ดู event ที่ตกลง DLQ ของ product-service เท่านั้น
service:"product-service" and msg:"handler gave up -> DLQ"

# 2) ดู error ทั้งหมดทุก service (level 50)
level >= 50

# 3) ตาม event ก้อนเดียวข้ามทุก service ด้วย messageId
messageId:"a1b2c3d4-...."

# 4) เฉพาะ event ของ order.placed บน partition 1 ที่ offset > 100
event:"order.placed" and partition:1 and offset > 100

# 5) ช่วงที่ broadcast ไปถึง client มากผิดปกติ
component:"realtime" and clients >= 50
```

ทั้งหมดนี้เป็น **term/range query ตรง ๆ** — เร็วและแม่น เพราะค้นบน field ที่
index ไว้ ไม่ใช่ regex บนประโยค

### 5.4 aggregation / dashboard ที่เปิดทางให้

- นับจำนวน DLQ **แยกตาม `event`** → รู้ว่า event type ไหนพังบ่อย
- กราฟ `level:error` ตามเวลา (`time`) → เห็น spike ของปัญหา
- เฉลี่ย `attempts` ก่อนยอมแพ้ → จูน `DLQ_MAX_RETRIES`
- นับ `event published` เทียบ `event handled` ต่อ `service` → ดู lag/หาย

### 5.5 ข้อควรระวังเรื่อง mapping (สำคัญตอนต่อ ES จริง)

1. **ชนิด field ต้องคงที่** — field หนึ่ง ๆ ห้ามเป็นเลขบ้างเป็นข้อความบ้าง ไม่งั้น
   ES จะ reject document (mapping conflict) โค้ดนี้คุม `err` ให้เป็น string เสมอ
   (`err: err.message`) และ `key` ถ้าไม่มีจะ **ไม่ใส่** (เป็น `undefined`) แทนที่จะ
   ใส่ค่าชนิดอื่น
2. **`time` เป็น epoch ms** — ต้องตั้ง mapping/Logstash ให้ parse เป็น `date`
   ไม่งั้นจะกลายเป็นตัวเลขธรรมดา ใช้ใน timeline ของ Kibana ไม่ได้
3. **`level` เป็นตัวเลข** — ถ้าอยากเห็นเป็น `"info"/"error"` ให้แปลงที่ Logstash
   หรือใส่ pino formatter ภายหลัง (ตอนนี้คงเป็นเลขเพื่อความเร็ว)
4. **`offset` เป็น string** — กันเลขใหญ่เกิน int ของ Kafka offset; ค้นแบบ term ได้
   แต่ถ้าจะเทียบ `>` ต้องระวังว่ามันถูก map เป็น keyword

---

## 6. การตั้งค่า (Environment variables)

| ตัวแปร | ค่า default | ผล |
|--------|-------------|-----|
| `LOG_LEVEL` | `info` | ระดับ log ต่ำสุดที่จะพ่นออก (`trace`/`debug`/`info`/`warn`/`error`/`fatal`) |
| `LOG_PRETTY` | (ไม่ตั้ง) | ตั้ง `1` เพื่อได้ log สีอ่านง่ายตอน dev — production อย่าตั้ง (ELK ต้องการ JSON) |
| `SERVICE_NAME` | ชื่อ service | override ค่า field `service` ในทุกบรรทัด |

ตัวอย่างรันแบบอ่านง่ายตอน dev:

```bash
LOG_PRETTY=1 LOG_LEVEL=debug npm run dev
```

---

## 7. ข้อสังเกต / สิ่งที่ยังไม่ทำ

- **`event handled` log ที่ระดับ info จะถี่มากตอนโหลดหนัก** — ถ้า production เสียง
  ดังเกินไป ให้ลดเป็น `log.debug` แล้วรันที่ `LOG_LEVEL=info`
- **startup banner กับ Express error handler ใน `index.js`** ยังเป็น `console.*`
  อยู่ (ตั้งใจ เพราะไม่ใช่ "event") เปลี่ยนเป็น logger ทีหลังได้
- **ELK ยังไม่ถูก wire** — `elk/filebeat`, `elk/logstash` ยังเป็นโฟลเดอร์เปล่า และ
  `docker-compose.yml` ยังไม่มี service ของ Filebeat/Logstash/Elasticsearch/Kibana
  ขั้นต่อไปคือ: ให้ Filebeat อ่าน container stdout → decode JSON (`json.keys_under_root`)
  → ส่งเข้า Logstash/Elasticsearch แล้วเปิด Kibana ค้นตามตัวอย่างข้อ 5

---

## 8. สรุปสั้น

1. ใช้ **pino** พ่น log เป็น **JSON 1 บรรทัด/1 event** ออก stdout
2. ทุกจุดของเส้นทาง event (publish / consume / retry / DLQ / WebSocket) ถูก log
   พร้อม field มาตรฐาน: `service`, `component`, `event`, `topic`, `partition`,
   `offset`, `key`, `messageId`, `level`, `msg`
3. เพราะเป็น JSON → Elasticsearch ได้ **field ที่ค้นหา/รวมยอดได้จริง** โดยไม่ต้อง
   grok ทำให้ search **เร็ว แม่น และทำ dashboard ได้** ต่างจาก `console.log` เดิม
   ที่เป็นข้อความก้อนเดียว
