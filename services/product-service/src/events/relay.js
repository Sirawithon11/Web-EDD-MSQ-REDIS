// Background relay: the "dispatcher" half of the transactional-outbox pattern.
// It polls the outbox for unpublished events and HTTP-POSTs each one to every
// subscriber registered for its type. No message broker involved.
const prisma = require("../prisma");
const subscriptions = require("./subscriptions");

const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 2000);
const BATCH = Number(process.env.OUTBOX_BATCH || 50);
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 10);
const SECRET = process.env.EVENT_SECRET || "dev-event-secret";

function targetsFor(type) {
  return (subscriptions[type] || []).filter(Boolean);
}

async function post(base, event) {
  const res = await fetch(`${base}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-event-secret": SECRET },
    body: JSON.stringify({
      id: event.eventId,
      type: event.type,
      payload: event.payload,
      occurredAt: event.createdAt,
    }),
  });
  if (!res.ok) throw new Error(`${base} -> ${res.status}`);
}

// Deliver one event to all of its subscribers. If a type has no subscribers,
// this resolves immediately and the event is simply marked PUBLISHED.
async function deliver(event) {
  await Promise.all(targetsFor(event.type).map((base) => post(base, event)));
}

async function tick() {
  const batch = await prisma.outboxEvent.findMany({
    where: { status: "PENDING", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { id: "asc" },
    take: BATCH,
  });

  for (const event of batch) {
    try {
      await deliver(event);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
    } catch (err) {
      const attempts = event.attempts + 1;
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          lastError: String(err && err.message ? err.message : err),
        },
      });
    }
  }
}

let timer = null;
function startRelay() {
  if (timer) return;
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      console.error("[relay] tick error:", err);
    }
    timer = setTimeout(loop, POLL_MS);
  };
  loop();
  console.log(`[relay] started (poll ${POLL_MS}ms, max attempts ${MAX_ATTEMPTS})`);
}

module.exports = { startRelay, tick, deliver };
