// Realtime stock push (WebSocket fan-out backed by Kafka).
//
// The gateway is the single entry point the browser talks to, so it is also the
// place we expose a WebSocket. We join our OWN Kafka consumer group ("gateway")
// and subscribe to "product.stock.changed" — the event product-service already
// publishes on every stock mutation (checkout decrement, restock, admin update).
// Each event is broadcast as JSON to every connected browser, which patches its
// local view without re-fetching. Read-only fan-out: clients never send to us.
const { WebSocketServer } = require("ws");
const { Kafka, logLevel } = require("kafkajs");

const BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || "gateway";
const RECONNECT_MS = Number(process.env.EVENTS_RECONNECT_MS || 3000);

// Attach a WebSocket server to the existing HTTP server (path /ws) and start a
// Kafka consumer that broadcasts stock changes to all connected clients.
function attachRealtime(server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    // Keepalive: mark sockets alive on pong; a dead one is terminated below.
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", () => {}); // ignore; the close handler cleans up
  });

  // Drop sockets that stopped answering pings (e.g. a tab that vanished).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on("close", () => clearInterval(heartbeat));

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  startStockConsumer(broadcast);
  return wss;
}

function startStockConsumer(broadcast) {
  const kafka = new Kafka({
    clientId: CLIENT_ID,
    brokers: BROKERS,
    logLevel: logLevel.NOTHING,
    retry: { initialRetryTime: 300, retries: 10 },
  });

  (async function attach() {
    try {
      const consumer = kafka.consumer({ groupId: "gateway" });
      await consumer.connect();
      await consumer.subscribe({ topic: "product.stock.changed", fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ message }) => {
          let payload;
          try {
            payload = JSON.parse(message.value.toString());
          } catch {
            return; // bad message — nothing to push
          }
          if (payload?.productId == null) return;
          broadcast({
            type: "product.stock.changed",
            productId: payload.productId,
            stock: payload.stock,
          });
        },
      });
      console.log(`[realtime] consuming "product.stock.changed" -> WebSocket /ws`);
    } catch (err) {
      console.error(`[realtime] consumer attach failed: ${err.message}; retry in ${RECONNECT_MS}ms`);
      setTimeout(attach, RECONNECT_MS);
    }
  })();
}

module.exports = { attachRealtime };
