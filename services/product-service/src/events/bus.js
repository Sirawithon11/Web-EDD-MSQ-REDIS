// Kafka event bus (pure broker — no outbox/inbox).
//
// Topology: ONE TOPIC PER EVENT TYPE (e.g. "product.created"). Producers send to
// the topic named after the event type. Each consuming service joins its OWN
// consumer group and subscribes to the topics it cares about, so its read
// offsets are tracked independently — the Kafka equivalent of a durable
// per-service queue — and adding/removing a consumer never touches the producer.
//
// Trade-offs (unchanged from the previous RabbitMQ design):
//   * publish happens AFTER the DB commit, so a crash in that window loses the
//     event (at-most-once for that gap) — acceptable for this demo.
//   * there is no inbox dedupe, so a redelivery (consumer crash before the offset
//     commit) can re-run a handler. Upserts are safe; counters can double-count.
//   * on handler failure we RETRY a few times with backoff (for transient errors
//     like a DB blip); if it still fails the event is moved to a per-group DLQ
//     topic "<groupId>.dlq" and the offset commits, so the partition keeps
//     flowing and a poison message can't loop forever. A bad JSON value is
//     treated as permanent and goes straight to the DLQ without retrying. The
//     event is preserved in the DLQ for later inspection/replay. NOTE: handlers
//     are NOT idempotent yet, so a retry can double-count — inbox dedupe is
//     intentionally out of scope here.
const { Kafka, logLevel } = require("kafkajs");
const { randomUUID } = require("crypto");

const BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || "service";
const RECONNECT_MS = Number(process.env.EVENTS_RECONNECT_MS || 3000);

// DLQ / retry settings (มี default — ไม่ตั้ง env ก็ทำงานได้)
const DLQ_MAX_RETRIES = Number(process.env.DLQ_MAX_RETRIES || 3); // ลอง handler กี่ครั้งก่อนยอมแพ้
const DLQ_RETRY_BACKOFF_MS = Number(process.env.DLQ_RETRY_BACKOFF_MS || 300); // backoff ฐาน (exponential)
const DLQ_SUFFIX = process.env.DLQ_SUFFIX || ".dlq"; // DLQ topic = "<groupId><DLQ_SUFFIX>"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//  สร้าง Kafka client object ด้วยไลบรารี kafkajs (เชื่อมกับ kafka cluster ตรงนี้)
//  — เป็นตัวตั้งค่าการเชื่อมต่อกับ Kafka cluster ก่อนจะเอาไปสร้าง producer/consumer ต่อ
const kafka = new Kafka({ 
  clientId: CLIENT_ID, // เป็นชื่อแทน kafka client object ตัวนี้ เมื่อไปตรวจสอบใน kafka จะใช้ชื่อนี้แทน
  brokers: BROKERS, // รายชื่อ node ที่ต้องเชื่อมต่อ กับ service นี้
  logLevel: logLevel.NOTHING, // ปิด log ของ library
  retry: { initialRetryTime: 300, retries: 10 }, // Kafka เชื่อมต่อแล้วเกิดล้มเหลว ให้ลองใหม่กี่ครั้ง และเว้นช่วงเท่าไหร่
});

let producer = null; // resolved once connected
let connecting = null; // in-flight connect promise (so callers can await it)

//สร้าง producer และนำ producer ไปเชื่อมกับ kafka cluster
function connectBus() {
  connecting = (async function connect() {
    try {
      const p = kafka.producer({ allowAutoTopicCreation: true });  //สร้างตัว producer และกำหนด rule การทำงานของตัว producer เท่านั้น ยังไม่ได้เชื่อมต่อ 
      await p.connect();  // นำตัว producer ไปผูกกับ Kafka cluster
      producer = p;
      console.log(`[bus] producer connected to ${BROKERS.join(",")}`);
      return p;
    } catch (err) {
      console.error(`[bus] connect failed: ${err.message}; retry in ${RECONNECT_MS}ms`);
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
      return connect();
    }
  })();
  return connecting;
}


//ตรวจสอบว่า ตัว producer ยังเชื่อมต่อกับ Kafka cluster อยู่ไหม (มีค่าไหม)
function getProducer() {
  if (producer) return Promise.resolve(producer);
  return connecting || connectBus();
}

// การ publis event จะถูก publish ผ่าน producer (producer จะถูกสร้างจาก kafka client object)
async function publish(type, payload) {
  const p = await getProducer();
  const key = payload?.id ?? payload?.productId ?? payload?.userId; // เรากำหนดให้มี 3 key เนื่องจากมี 3 partition  ถ้าไม่มี event key ซึ่ง kafka จะสุ่มใส่
  await p.send({
    topic: type,
    messages: [
      {
        key: key != null ? String(key) : undefined, // เป็นตัวเลือก partition ว่าจะนำไปใส่ใน partition ไหน โดยเลือกตาม key
        value: JSON.stringify(payload),
        headers: { type, messageId: randomUUID(), timestamp: String(Date.now()) },
      },
    ],
  });
}


// ส่ง event ที่ handle ไม่สำเร็จเข้า "กล่องของพัง" (DLQ topic ของ group นั้น = "<groupId>.dlq")
// คงของเดิมไว้ครบ (key + value ดิบ ไม่ re-stringify) แล้วแนบ header บอกสาเหตุไว้ debug/replay ทีหลัง
// ถ้า send พังเอง (เช่น Kafka ล่ม) จะ throw ออกไป → eachMessage ไม่ commit → redeliver ทีหลัง (at-least-once)
async function sendToDlq({ groupId, message, originalTopic, error, attempts }) {
  const p = await getProducer();
  const headers = { ...(message.headers || {}) }; // copy header เดิม (type, messageId, timestamp)
  headers["x-original-topic"] = originalTopic;
  headers["x-consumer-group"] = groupId;
  headers["x-error"] = String(error ?? "unknown");
  headers["x-error-attempts"] = String(attempts);
  headers["x-failed-at"] = String(Date.now());
  await p.send({
    topic: `${groupId}${DLQ_SUFFIX}`,
    messages: [{ key: message.key, value: message.value, headers }], // ของดิบเดิมทั้งก้อน
  });
}

//จะมีการสร้างตัว consumer (จาก kafka client object) และ มอบชื่อ Group ให้แก้ ตัว consumer
function startConsumer({ groupId, topics, handlers }) {
  (async function attach() {
    try {
      const consumer = kafka.consumer({ groupId }); // สร้างตัว consume และมอบชื่อให้ตัว consume
      await consumer.connect(); // ตัว consume เชื่อมกับ kafka cluster
      for (const topic of topics) await consumer.subscribe({ topic, fromBeginning: false }); // เรียก event มา consume ตาม type ที่กำหนด จาก partition ใดๆ
      await consumer.run({ // logic นำ event ที่ consume ได้มาแยกเข้า handle ตาม type
        eachMessage: async ({ topic, message }) => {
          const type = message.headers?.type?.toString() || topic;

          // 1) แปลง payload — parse พัง = error ถาวร (ลองใหม่ก็พังเหมือนเดิม) → เข้า DLQ ทันที
          let payload;
          try {
            payload = JSON.parse(message.value.toString());
          } catch (err) {
            console.error(`[bus] "${type}" parse failed -> DLQ: ${err.message}`);
            await sendToDlq({ groupId, message, originalTopic: topic, error: err.message, attempts: 0 });
            return;
          }

          const handler = handlers[type];
          if (!handler) return; // ไม่มี handler สำหรับ type นี้ → ข้าม (commit)

          // 2) ลอง handler ซ้ำแบบ backoff สำหรับ error ชั่วคราว
          let lastErr;
          let made = 0;
          for (let attempt = 1; attempt <= DLQ_MAX_RETRIES; attempt++) {
            made = attempt;
            try {
              await handler(payload);
              return; // สำเร็จ → commit
            } catch (err) {
              lastErr = err;
              if (err.permanent || attempt >= DLQ_MAX_RETRIES) break; // ถาวร/ครบจำนวน → เลิกลอง
              const backoff = DLQ_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
              console.error(`[bus] handler "${type}" failed (attempt ${attempt}/${DLQ_MAX_RETRIES}): ${err.message}; retry in ${backoff}ms`);
              await sleep(backoff);
            }
          }

          // 3) ยังพังอยู่ → เข้า DLQ แล้วไปต่อ (offset commit)
          console.error(`[bus] handler "${type}" gave up after ${made} attempt(s) -> DLQ: ${lastErr?.message}`);
          await sendToDlq({ groupId, message, originalTopic: topic, error: lastErr?.message, attempts: made });
        },
      });
      console.log(`[bus] consuming group "${groupId}" <- [${topics.join(", ")}]`);
    } catch (err) {
      console.error(`[bus] consumer "${groupId}" attach failed: ${err.message}; retry in ${RECONNECT_MS}ms`);
      setTimeout(attach, RECONNECT_MS);
    }
  })();
}

module.exports = { connectBus, publish, startConsumer };
