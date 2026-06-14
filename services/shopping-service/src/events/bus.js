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

// DLQ / retry settings (sensible defaults — works without any env set)
const DLQ_MAX_RETRIES = Number(process.env.DLQ_MAX_RETRIES || 3); // handler attempts before giving up
const DLQ_RETRY_BACKOFF_MS = Number(process.env.DLQ_RETRY_BACKOFF_MS || 300); // base backoff (exponential)
const DLQ_SUFFIX = process.env.DLQ_SUFFIX || ".dlq"; // DLQ topic = "<groupId><DLQ_SUFFIX>"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: BROKERS,
  logLevel: logLevel.NOTHING, // keep kafkajs' chatty retry logs out of the app log
  retry: { initialRetryTime: 300, retries: 10 },
});

let producer = null; // resolved once connected
let connecting = null; // in-flight connect promise (so callers can await it)

// Connect the producer with retry. Never hard-fails: if Kafka isn't up yet it
// keeps retrying in the background so service startup survives a cold broker.
function connectBus() {
  connecting = (async function connect() {
    try {
      const p = kafka.producer({ allowAutoTopicCreation: true });
      await p.connect();
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

// Resolve the live producer, waiting on the in-flight connect if needed.
function getProducer() {
  if (producer) return Promise.resolve(producer);
  return connecting || connectBus();
}

// Publish a domain event to the topic named after its type. Call this AFTER the
// business DB transaction commits. Keyed by the entity id when present so events
// about the same entity land on the same partition (in-order per entity).
async function publish(type, payload) {
  const p = await getProducer();
  const key = payload?.id ?? payload?.productId ?? payload?.userId;
  await p.send({
    topic: type,
    messages: [
      {
        key: key != null ? String(key) : undefined,
        value: JSON.stringify(payload),
        headers: { type, messageId: randomUUID(), timestamp: String(Date.now()) },
      },
    ],
  });
}

// Move an event that couldn't be handled to the per-group DLQ topic "<groupId>.dlq".
// Keeps the original message intact (key + raw value) and attaches headers describing
// the failure for later inspection/replay. If this send itself fails (e.g. Kafka down)
// it throws, so eachMessage won't commit and the event is redelivered (at-least-once).
async function sendToDlq({ groupId, message, originalTopic, error, attempts }) {
  const p = await getProducer();
  const headers = { ...(message.headers || {}) }; // keep original headers (type, messageId, timestamp)
  headers["x-original-topic"] = originalTopic;
  headers["x-consumer-group"] = groupId;
  headers["x-error"] = String(error ?? "unknown");
  headers["x-error-attempts"] = String(attempts);
  headers["x-failed-at"] = String(Date.now());
  await p.send({
    topic: `${groupId}${DLQ_SUFFIX}`,
    messages: [{ key: message.key, value: message.value, headers }], // the raw original event
  });
}

// Register a consumer: join `groupId`, subscribe to `topics`, and dispatch each
// message to handlers[type]. Retries attaching in the background until Kafka is
// up, so startup never hard-fails on the broker.
function startConsumer({ groupId, topics, handlers }) {
  (async function attach() {
    try {
      const consumer = kafka.consumer({ groupId });
      await consumer.connect();
      for (const topic of topics) await consumer.subscribe({ topic, fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ topic, message }) => {
          const type = message.headers?.type?.toString() || topic;

          // 1) Parse the payload. A bad JSON value is permanent (retrying won't help) -> DLQ now.
          let payload;
          try {
            payload = JSON.parse(message.value.toString());
          } catch (err) {
            console.error(`[bus] "${type}" parse failed -> DLQ: ${err.message}`);
            await sendToDlq({ groupId, message, originalTopic: topic, error: err.message, attempts: 0 });
            return;
          }

          const handler = handlers[type];
          if (!handler) return; // no handler for this type -> skip (commit)

          // 2) Run the handler, retrying transient failures with exponential backoff.
          let lastErr;
          let made = 0;
          for (let attempt = 1; attempt <= DLQ_MAX_RETRIES; attempt++) {
            made = attempt;
            try {
              await handler(payload);
              return; // success -> commit
            } catch (err) {
              lastErr = err;
              if (err.permanent || attempt >= DLQ_MAX_RETRIES) break; // permanent / out of tries
              const backoff = DLQ_RETRY_BACKOFF_MS * 2 ** (attempt - 1);
              console.error(`[bus] handler "${type}" failed (attempt ${attempt}/${DLQ_MAX_RETRIES}): ${err.message}; retry in ${backoff}ms`);
              await sleep(backoff);
            }
          }

          // 3) Still failing -> move to the DLQ and carry on (offset commits).
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
