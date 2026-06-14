# โครงสร้างของ Kafka

เอกสารนี้อธิบายโครงสร้างภายในของ Apache Kafka ตั้งแต่ภาพใหญ่ของคลัสเตอร์
ไปจนถึงระดับ partition/offset และเชื่อมโยงกลับมาที่ config จริงของโปรเจกต์นี้
([docker-compose.yml](../docker-compose.yml))

โปรเจกต์นี้รัน Kafka แบบ **3-node cluster + KRaft mode** (ไม่ใช้ ZooKeeper)
ทุก node เป็นทั้ง broker + controller, ทุก topic มี **3 partition** และ
**replication factor 3** เพื่อให้ทนต่อการที่ node ใดๆ 1 ตัวพัง และกระจายโหลดข้าม node

---

## 1. คำศัพท์หลัก (Glossary)

| คำ | ความหมายสั้น ๆ |
|----|----------------|
| **Cluster** | กลุ่มของ Kafka หลายเครื่องที่ทำงานร่วมกัน |
| **Node** | เครื่อง server ของ Kafka ในคลัสเตอร์นั้นๆ แบ่งได้เป็น 2 ประเภท คือ Broker และ Controller |
| **Broker** | เครื่องserver ที่เก็บข้อมูลและรับ-ส่ง event |
| **Controller** | บทบาทที่ดูแล metadata ของคลัสเตอร์ (มี topic อะไร, partition อยู่ที่ไหน, ใครเป็น leader) |
| **Topic** | ช่อง/หมวดของ event เปรียบเหมือนชื่อสมุดบันทึก 1 เล่ม |
| **Partition** | การแบ่งย่อยของ topic ออกเป็นหลายลำดับ เพื่อกระจายโหลดและขนานการอ่าน |
| **Offset** | เลขลำดับของ message ภายใน partition (เพิ่มขึ้นเรื่อย ๆ ไม่ถอยหลัง) |
| **Producer** | ฝ่ายเขียน event ลง topic |
| **Consumer** | ฝ่ายอ่าน event ออกจาก topic |
| **Consumer Group** | กลุ่ม consumer ที่แบ่งงานกันอ่าน partition ของ topic เดียวกัน (Group = service เดียวกันหลายๆสำเนา ช่วยกันรับ event เดียวกัน) |

เพิ่มเติม
1. โดยทั่วไป 1 project จะมี kafka 1 cluster โดย 1 cluster จะสามารถมีได้หลาย node ขึ้นอยู่กับที่เราออกแบบ ถ้ามีหลาย Node(Broker) การส่ง event message จะทนทานมากขึ้น กรณีมี node พัง
2. สมัยใหม่ 1 node สามารถเป็นได้ทั้ง Broker และ controller
3. Consumer Group คือ 1 service สร้างหลายๆสำเนาของ service นี้ ช่วยกันรับ event เดียวกัน จากหลาย partition เพื่อช่วยกันทำงานเดียวกัน เรียกว่า 1 Group (load balancing) (ให้ docker สร้าง container นี้ เพิ่มก็จะเป็น load balancing แล้ว)
---

## 2. ภาพใหญ่: Cluster และ Node

ในระบบ production จริง Kafka รันหลาย node เพื่อกระจายโหลดและทนต่อความเสียหาย:

```
                     Kafka Cluster
   ┌─────────────────────────────────────────────────┐
   │   ┌──────────┐   ┌──────────┐   ┌──────────┐     │
   │   │  Node 1  │   │  Node 2  │   │  Node 3  │      │
   │   │ broker + │   │ broker   │   │ broker   │      │
   │   │ controller│  │          │   │          │      │
   │   └──────────┘   └──────────┘   └──────────┘     │
   │        ▲              ▲               ▲           │
   │        └── สำเนาข้อมูล (replica) กระจายข้ามเครื่อง ──┘
   └─────────────────────────────────────────────────┘
```

แต่ละ node ทำได้ 2 บทบาท:

- **Broker** — เก็บข้อมูล (partition) จริง และรับ-ส่ง event กับ client
- **Controller** — ผู้จัดการ metadata ของคลัสเตอร์ (เลือก leader, จำว่า partition อยู่ node ไหน)

### โปรเจกต์นี้ = 3 node

```
                    Kafka Cluster (3 nodes)
   ┌──────────────────────────────────────────────────────┐
   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐   │
   │  │   kafka-1    │ │   kafka-2    │ │   kafka-3    │    │
   │  │  node id 1   │ │  node id 2   │ │  node id 3   │    │
   │  │ broker +     │ │ broker +     │ │ broker +     │    │
   │  │ controller   │ │ controller   │ │ controller   │    │
   │  └──────────────┘ └──────────────┘ └──────────────┘    │
   │   host :9092       host :9094       host :9095         │
   │                                                        │
   │   CLUSTER_ID: MkU3OEVB... (เดียวกันทั้ง 3 → เป็น 1 cluster) │
   └──────────────────────────────────────────────────────┘
```

config ที่เกี่ยวข้อง (ใช้ YAML anchor `x-kafka-env` ร่วมกันทั้ง 3 node, ต่าง
กันแค่ `KAFKA_NODE_ID` + listeners):

```yaml
KAFKA_PROCESS_ROLES: broker,controller        # ทุก node ทำทั้ง 2 บทบาท
# controller ที่โหวตได้คือทั้ง 3 node → ต้องมี majority (2 ตัว) มีชีวิตอยู่
KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka-1:9093,2@kafka-2:9093,3@kafka-3:9093
CLUSTER_ID: MkU3OEVBNTcwNTJENDM2Qk            # UUID เดียวกันทั้ง 3 node = คลัสเตอร์เดียว
KAFKA_NODE_ID: 1                              # ต่างกันต่อ node (1 / 2 / 3)
```

> **KRaft vs ZooKeeper:** สมัยก่อน Kafka ต้องรัน ZooKeeper แยกเพื่อทำหน้าที่ controller
> KRaft mode ทำให้ Kafka จัดการ metadata เองได้ ไม่ต้องมี ZooKeeper อีก ติดตั้งง่ายกว่า
> จึงมี config กลุ่ม `CONTROLLER` และ `CLUSTER_ID` ปรากฏขึ้น


**เพิ่มเติม**
มีหลาย Node ทำให้ 1 topic(หลาย partition) กระจาย partition ไปได้หลาย node ทำให้ events ที่ถูกส่งเข้ามา กระจายไปหลาย node ช่วยเรื่องรับ events เยอะๆ

---

## 3. Listeners: ช่องทางเชื่อมต่อ

Kafka มี "ผู้ติดต่อ" หลายฝั่งที่ใช้ address คนละแบบ จึงต้องแยก listener:

```
   ┌─────────────────── ภายใน Docker network ───────────────────┐
   │  user-service ──┐                                           │
   │  product-service├─► kafka-1:29092,kafka-2:29092,kafka-3:29092│
   │  shopping-service┘   (INTERNAL listener ของแต่ละ node)       │
   │  kafka-ui ──────► kafka-1:29092,kafka-2:29092,kafka-3:29092 │
   └────────────────────────────────────────────────────────────┘

   ┌─────────────────── จากเครื่อง host ─────────────────────────┐
   │  CLI tools / debug ──► localhost:9092 / 9094 / 9095         │
   │                        (EXTERNAL listener ของ node 1/2/3)   │
   └────────────────────────────────────────────────────────────┘

   ┌─────────────────── ภายใน Kafka เอง ─────────────────────────┐
   │  controller quorum ──► kafka-{1,2,3}:9093 (CONTROLLER)      │
   └────────────────────────────────────────────────────────────┘
```

> **client ต่อ broker เดียวก็พอ:** service ตั้ง `KAFKA_BROKERS` เป็นรายชื่อ
> ทั้ง 3 node เพื่อใช้เป็น "bootstrap" — ต่อ node ไหนก่อนก็ได้ แล้ว Kafka จะบอก
> รายชื่อ node ที่เหลือ (advertised) กลับมาให้เอง การใส่หลาย node ช่วยให้ยัง
> เชื่อมต่อได้แม้ node แรกในลิสต์จะล่ม

config ที่เกี่ยวข้อง (ต่างกันต่อ node — ตัวอย่างคือ node 1):

```yaml
KAFKA_LISTENERS: INTERNAL://0.0.0.0:29092,CONTROLLER://0.0.0.0:9093,EXTERNAL://0.0.0.0:9092
KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka-1:29092,EXTERNAL://localhost:9092
KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT
KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
```

> **EXTERNAL ต่อ node ต่างพอร์ต host:** ภายใน container EXTERNAL listener อยู่
> ที่ `:9092` เหมือนกันทุก node แต่ map ออก host คนละพอร์ต (9092 / 9094 / 9095)
> และ advertised ต้องตรงกับพอร์ต host นั้น ไม่งั้น client จาก host จะต่อผิด node

> **ทำไมต้องแยก INTERNAL/EXTERNAL:** ตอน client ต่อเข้ามา broker จะตอบ "address ที่ให้ไปต่อจริง"
> (advertised). service ใน Docker เรียก hostname `kafka` ได้ แต่ host เครื่องเราเรียก `kafka`
> ไม่รู้จัก ต้องใช้ `localhost` ถ้าตั้ง advertised ผิด จะต่อครั้งแรกได้แต่ครั้งถัดไป connection ค้าง
> (เป็น bug ยอดฮิตของ Kafka บน Docker)

---

## 4. Topic และ Partition

Topic  แบ่งย่อยเป็นหลาย **partition**(ทุก partition รับ event keys เดียวกับ topic) แต่ละ partition ถูกกระจายไปหลาย node เพื่อแบ่ง load การส่ง events เข้ามา

แต่ละ partition จะรับ events เข้ามาแบบ append-only log (เพิ่ม event ต่อท้ายอย่างเดียว
ไม่แก้ไขข้อมูลเดิม และไม่ลบข้อมูลเก่าโดยตรง) โดยแต่ละ event จะถูกแยกแยะ/ถูกกำหนดตำแหน่งใน partition
ด้วย **offset**(การมอบตัวเลขให้ตามลำดับที่เข้ามา):

```
   Topic: "product.created"  (3 partitions, กระจาย leader ไปคนละ node)

   Partition 0  (leader: kafka-1):
   ┌────┬────┬────┬─────►
   │ 0  │ 1  │ 2  │
   └────┴────┴────┘
   Partition 1  (leader: kafka-2):
   ┌────┬────┬─────►
   │ 0  │ 1  │
   └────┴────┘
   Partition 2  (leader: kafka-3):
   ┌────┬────┬────┬────┬─────►
   │ 0  │ 1  │ 2  │ 3  │
   └────┴────┴────┴────┘
     ▲              ▲
   offset เก่าสุด   offset ใหม่สุด  (offset เป็นของแต่ละ partition แยกกัน)

   * แต่ละ partition เป็น append-only log ของตัวเอง อ่านไล่ไปข้างหน้าตามลำดับ
   * Kafka เก็บ message ไว้ตามระยะเวลา (retention) ไม่ได้ลบทันทีหลังอ่าน
```

**event ลง partition ไหน?** producer ใช้ `key` ของ message (โปรเจกต์นี้คือ id
ของ entity เช่น productId) มา hash → เลือก partition ดังนั้น event ของ entity
เดียวกันจะลง partition เดิมเสมอ (รับประกัน ordering ต่อ entity) ส่วน entity
ต่างกันกระจายไปคนละ partition ช่วยขนานการอ่าน — ดู [bus.js](../services/product-service/src/events/bus.js)
ฟังก์ชัน `publish` (สามารถเลือก เลือกได้ว่าให้เข้า partition ไหน แม้ Topic เดียวกัน)

ในโปรเจกต์นี้ทุก topic มี **3 partition** และ auto-create:

```yaml
KAFKA_NUM_PARTITIONS: 3                   # topic ใหม่มี 3 partition
KAFKA_DEFAULT_REPLICATION_FACTOR: 3       # แต่ละ partition ทำสำเนา 3 ชุดข้าม node
KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"   # publish/subscribe ครั้งแรกสร้าง topic ให้เลย
```

> **ordering:** Kafka รับประกันลำดับ **ภายใน partition เดียว** เท่านั้น การ key
> ด้วย id ของ entity จึงสำคัญ — มันทำให้ event ของ entity เดียวกันอยู่ partition
> เดียวกัน (ลำดับถูกต้อง) ขณะที่ยังกระจายโหลดข้าม 3 partition ได้
>
> **ขนานการอ่านจริง:** 1 partition ถูกอ่านโดย consumer ได้แค่ตัวเดียวต่อ group
> ถ้าอยากให้ service อ่านขนาน 3 partition พร้อมกัน ต้องรัน service นั้นหลายสำเนา
> (เช่น `docker compose up --scale product-service=3`) ใน consumer group เดียวกัน

---

## 5. Producer / Consumer / Consumer Group

```
   Producer                Topic: order.created            Consumers
   ───────────             (partition 0)                   ─────────

   shopping-service ──publish──► [0][1][2][3] ──┬──► product-service
                                                │    (group: product-service)
                                                │    อัปเดต stock / read model
                                                │
                                                └──► (consumer group อื่น ๆ
                                                     อ่าน event ชุดเดียวกันได้
                                                     โดยมี offset ของตัวเอง)
```

หลักการสำคัญ:

- **แต่ละ consumer group มี offset ของตัวเอง** → หลาย service อ่าน event ชุดเดียวกันได้
  โดยไม่แย่งกัน (เหมาะกับ event-driven / pub-sub)
- **ภายใน group เดียวกัน** partition หนึ่งจะถูกอ่านโดย consumer แค่ตัวเดียว → กระจายงานได้
- offset ถูกเก็บใน internal topic ชื่อ `__consumer_offsets`

config ที่เกี่ยวข้อง:

```yaml
KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1   # topic เก็บ offset ทำสำเนา 1 ชุด
KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0   # ไม่หน่วงเวลาก่อน rebalance (dev ใช้งานได้ทันที)
```

ในโปรเจกต์ แต่ละ service ตั้ง `KAFKA_CLIENT_ID` เป็นชื่อ service ของตัวเอง
(`user-service`, `product-service`, `shopping-service`) ซึ่งใช้อ้างอิงเป็น consumer group ด้วย

---

## 6. Replication (สำเนาข้อมูล)

ในคลัสเตอร์หลาย node ซึ่ง 1 topic จะแบ่งได้หลาย partition โดยเราจะสร้างสำเนาของแต่ละ partition เป็นหลายๆชุด และกระจายแบ่งไปหลายๆ Node โดย partition เดียวกันจะไม่ให้อยู่ใน Node เดียวกัน ป้องกันกรณี Node A เสีย และ partition X (หลัก) อยู่ใน Node A ก็จะมี partition X (สำเนา) ที่อยู่ใน Node อื่นทำงานแทนได้ (event ที่เข้ามาใน partition หลัก จะต้องเข้า partition สำเนา ด้วยเสมอ)

```
   3 node (โปรเจกต์นี้) — Partition 0 ของ topic "product.created"
   ──────────────────────────────────────────────────────────────
     leader  → kafka-1     ◄── producer/consumer คุยกับ leader
     replica → kafka-2     ◄── คอยตามสำเนาให้ทัน (in-sync)
     replica → kafka-3     ◄── ถ้า kafka-1 ล่ม จะเลือก replica ตัวนี้เป็น leader ใหม่
```

โปรเจกต์นี้มี 3 node จึงตั้ง replication factor = `3` (สำเนาทุก partition ครบ
ทั้ง 3 node) และ min in-sync replicas = `2` (เขียนสำเร็จต้องมีอย่างน้อย 2 สำเนา
ตรงกัน → ทนการล่มของ 1 node ได้โดยไม่เสียข้อมูล):

```yaml
KAFKA_DEFAULT_REPLICATION_FACTOR: 3            # topic ของ business event
KAFKA_MIN_INSYNC_REPLICAS: 2
KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 3      # internal: __consumer_offsets
KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 3
KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 2
```

> **ทำไม min ISR = 2 ไม่ใช่ 3:** ถ้าตั้ง 3 แล้ว node ใดล่ม 1 ตัว จะเขียนไม่ได้เลย
> (เพราะต้องครบ 3) การตั้ง 2 จึงเป็นจุดสมดุล: ทน node ล่ม 1 ตัว แต่ยังเขียนได้

---

## 7. Retry + DLQ (กล่องของพังเมื่อ handle ไม่สำเร็จ)

Kafka **ไม่มี** DLQ/retry ในตัว (ต่างจาก RabbitMQ ที่มี DLX) — มันเป็นแค่ log ที่ทนทาน
เรื่อง retry/DLQ จึงเป็นหน้าที่ของฝั่ง consumer ที่ต้องเขียนเอง โปรเจกต์นี้ทำไว้ใน
[bus.js](../services/product-service/src/events/bus.js) ฟังก์ชัน `startConsumer`:

```
event เข้า → parse
   │
   ├─ parse พัง (JSON เสีย) = error ถาวร ──────────────► DLQ ทันที (ไม่ retry)
   │
   └─ parse ผ่าน → เรียก handler
         │
         ├─ สำเร็จ ─────────────────────────────────► commit ไปต่อ ✅
         │
         └─ พัง → ลองใหม่แบบ backoff (300 → 600 → 1200ms)
                  ครบ DLQ_MAX_RETRIES (default 3) แล้วยังพัง
                                          │
                                          ▼
                       ส่งเข้า DLQ topic "<groupId>.dlq" แล้ว commit ไปต่อ
                       (event ไม่หาย, partition หลักไม่ค้าง, ไว้ replay ทีหลัง)
```

- **DLQ ตั้งชื่อตาม consumer group** เช่น `product-service.dlq`, `user-service.dlq`
  เพราะ 1 topic (เช่น `order.placed`) ถูก consume หลาย group — แยก DLQ ตาม group
  ทำให้รู้ว่า service ไหน handle พัง และไม่ปนกัน
- message ใน DLQ คงของเดิมครบ (key + value) + แนบ header `x-original-topic`,
  `x-error`, `x-error-attempts`, `x-failed-at`, `x-consumer-group`
- ปรับได้ด้วย env: `DLQ_MAX_RETRIES`, `DLQ_RETRY_BACKOFF_MS`, `DLQ_SUFFIX`

> **ข้อจำกัดที่ยังเหลือ:** (1) retry เป็นแบบ in-process จึงหน่วง partition นั้นชั่วคราว
> ระหว่าง backoff (ถ้าต้องการไม่ block ต้องแยก "retry topic"); (2) ยังไม่มี inbox dedupe
> handler ที่เป็น counter ([handlers.js](../services/product-service/src/events/handlers.js))
> จึงอาจนับเกินถ้าถูก retry — ดู `messageId` ใน header ที่เตรียมไว้สำหรับทำ idempotency ภายหลัง

ดู DLQ จริงได้ที่ **Kafka UI** http://localhost:8081 → topic ชื่อ `<service>.dlq`

---

## 8. สรุป mapping: config → โครงสร้าง

| Config | คุมส่วนไหนของโครงสร้าง |
|--------|------------------------|
| `KAFKA_NODE_ID`, `KAFKA_PROCESS_ROLES` | ตัวตน + บทบาทของ node |
| `KAFKA_CONTROLLER_QUORUM_VOTERS`, `CLUSTER_ID`, `*_LISTENER_NAMES` | กลไก controller (KRaft) |
| `KAFKA_LISTENERS`, `KAFKA_ADVERTISED_LISTENERS`, `*_SECURITY_PROTOCOL_MAP` | ช่องทางเชื่อมต่อ |
| `KAFKA_NUM_PARTITIONS`, `KAFKA_AUTO_CREATE_TOPICS_ENABLE` | topic / partition |
| `KAFKA_*_REPLICATION_FACTOR`, `*_MIN_ISR` | replication (สำเนาข้อมูล) |
| `KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS` | พฤติกรรม consumer group |

> ภาพรวม config ทั้งหมด = "รัน Kafka 3-node cluster แบบ KRaft, ไม่มี security,
> ทุก topic 3 partition / replication factor 3, เปิด auto-create topic"
> ใกล้เคียง production มากขึ้น (ทน node ล่ม 1 ตัว + กระจายโหลด) แต่ยังตัด security
> ออกเพื่อความง่ายในการ dev

---

ดูเพิ่ม: [ARCHITECTURE.md](../ARCHITECTURE.md) สำหรับภาพรวมทั้งระบบ
และ [docker-compose.yml](../docker-compose.yml) สำหรับ config จริง
