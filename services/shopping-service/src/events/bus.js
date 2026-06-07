// RabbitMQ event bus (pure broker — no outbox/inbox).
//
// Topology: a single durable TOPIC exchange (domain.events). Producers publish
// with routingKey = event type (e.g. "product.created"). Each consuming service
// declares its OWN durable queue and binds it to the event types it cares about,
// so adding/removing a consumer never touches the producer.
//
// Trade-offs of dropping the transactional outbox/inbox:
//   * publish happens AFTER the DB commit, so a crash in that window loses the
//     event (at-most-once for that gap) — acceptable for this demo.
//   * there is no inbox dedupe, so a redelivery (consumer crash before ack) can
//     re-run a handler. Upserts are safe; counters can double-count.
const amqp = require("amqplib");
const { randomUUID } = require("crypto");

const URL = process.env.RABBITMQ_URL || "amqp://guest:guest@localhost:5672";
const EXCHANGE = process.env.EVENTS_EXCHANGE || "domain.events";
const PREFETCH = Number(process.env.EVENTS_PREFETCH || 20);
const RECONNECT_MS = Number(process.env.EVENTS_RECONNECT_MS || 3000);

let channel = null;
// Registered consumers, replayed on every (re)connect so consumption survives a
// broker restart.
const consumers = [];

// Bind a queue to its event types and start consuming. Each delivery is parsed,
// dispatched to its handler, then ack'd on success / nack'd (no requeue) on
// failure so a poison message can't loop forever.
async function attach({ queue, bindings, handlers }) {
  await channel.assertQueue(queue, { durable: true });
  for (const key of bindings) await channel.bindQueue(queue, EXCHANGE, key);
  await channel.prefetch(PREFETCH);

  await channel.consume(queue, async (msg) => {
    if (!msg) return; // consumer cancelled by the server
    const type = msg.properties.type || msg.fields.routingKey;
    try {
      const payload = JSON.parse(msg.content.toString());
      const handler = handlers[type];
      if (handler) await handler(payload);
      channel.ack(msg);
    } catch (err) {
      console.error(`[bus] handler "${type}" failed:`, err.message);
      channel.nack(msg, false, false); // drop (no requeue) — avoids poison loop
    }
  });

  console.log(`[bus] consuming ${queue} <- [${bindings.join(", ")}]`);
}

async function setup() {
  const conn = await amqp.connect(URL);
  conn.on("error", (err) => console.error("[bus] connection error:", err.message));
  conn.on("close", () => {
    channel = null;
    console.warn(`[bus] connection closed; reconnecting in ${RECONNECT_MS}ms`);
    setTimeout(connectBus, RECONNECT_MS);
  });

  channel = await conn.createChannel();
  await channel.assertExchange(EXCHANGE, "topic", { durable: true });

  for (const cfg of consumers) await attach(cfg); // (re)attach after a reconnect
  console.log(`[bus] connected to ${URL} (exchange "${EXCHANGE}")`);
}

// Connect with retry. Resolves once connected; keeps retrying in the background
// if the broker isn't up yet, so service startup never hard-fails on RabbitMQ.
function connectBus() {
  return setup().catch((err) => {
    console.error(`[bus] connect failed: ${err.message}; retry in ${RECONNECT_MS}ms`);
    setTimeout(connectBus, RECONNECT_MS);
  });
}

// Resolve the live channel, briefly waiting if a (re)connect is in flight.
function getChannel(timeoutMs = 10000) {
  if (channel) return Promise.resolve(channel);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (channel) {
        clearInterval(t);
        resolve(channel);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error("RabbitMQ channel not ready"));
      }
    }, 100);
  });
}

// Publish a domain event. Call this AFTER the business DB transaction commits.
async function publish(type, payload) {
  const ch = await getChannel();
  ch.publish(EXCHANGE, type, Buffer.from(JSON.stringify(payload)), {
    persistent: true, // survive a broker restart (with the durable queue)
    contentType: "application/json",
    type,
    messageId: randomUUID(),
    timestamp: Date.now(),
  });
}

// Register a consumer. Attaches immediately if already connected, otherwise on
// the next successful connect.
function startConsumer(cfg) {
  consumers.push(cfg);
  if (channel) attach(cfg).catch((err) => console.error("[bus] attach failed:", err.message));
}

module.exports = { connectBus, publish, startConsumer };
