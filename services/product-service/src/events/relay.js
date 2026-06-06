// Background relay: the "dispatcher" half of the transactional-outbox pattern.
// It polls the outbox for unpublished events and HTTP-POSTs each one to every
// subscriber registered for its type. No message broker involved.
const prisma = require("../prisma");
const subscriptions = require("./subscriptions");

const POLL_MS = Number(process.env.OUTBOX_POLL_MS || 2000);
const BATCH = Number(process.env.OUTBOX_BATCH || 50);
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS || 10);
const SECRET = process.env.EVENT_SECRET || "dev-event-secret";

//ตรวจสอบว่า event ที่จะ publish มี keys or types ที่ตรงกับที่เตรียมไว้จะส่งไปให้ subscriber หรือไม่
function targetsFor(type) {
  return (subscriptions[type] || []).filter(Boolean);
}
//นำข้อมูลของ event ที่จะส่งไปให้ service อื่นๆ มาแปลงเป็นรูปแบบที่ subscriber ต้องการ 
// และส่งในรูปแบบ HTTP POST ไปยัง subscriber แต่ละตัวที่ subscribe event type นั้นๆ อยู่
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

// นำ event key ที่อยู่ใน outbox table มาเช็คว่า event type นั้นๆ มี subscriber หรือไม่ 
// ถ้ามีก็จะส่ง event นั้นไปยัง subscriber ทุกตัวที่ subscribe event type นั้นๆ อยู่
async function deliver(event) {
  await Promise.all(targetsFor(event.type).map((base) => post(base, event)));
}


// func. นี้จะทำการส่ง event ที่อยู่ใน outbox table (event ที่จะส่งไป service อื่น)
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



// function นี้ จะถูกเรียกเมื่อ server เริ่มทำงาน และจะทำงานตลอดที server ทำงาน โดยจะมีการเรียกใช้
// tick() ทุกๆ POLL_MS มิลลิวินาที  
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
