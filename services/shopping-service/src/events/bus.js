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
//   * on handler failure we log and move on (the offset still commits) so a
//     poison message can't loop forever — mirrors the old nack(no-requeue).
const { Kafka, logLevel } = require("kafkajs");
const { randomUUID } = require("crypto");

const BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || "service";
const RECONNECT_MS = Number(process.env.EVENTS_RECONNECT_MS || 3000);

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
          try {
            const payload = JSON.parse(message.value.toString());
            const handler = handlers[type];
            if (handler) await handler(payload);
          } catch (err) {
            // log and move on — the offset commits, so a poison message can't loop
            console.error(`[bus] handler "${type}" failed:`, err.message);
          }
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
