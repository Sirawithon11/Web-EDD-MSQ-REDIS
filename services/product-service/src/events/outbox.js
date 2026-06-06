const { randomUUID } = require("crypto");

// Write a domain event to the outbox. MUST be called with the same Prisma
// transaction client (`tx`) as the business change so the event is committed
// atomically with it — that's what makes delivery exactly mirror state.


//เก็บ event ที่จะส่งไปให้ service อื่นๆ ใน outbox table 
// โดยต้องเรียกใช้ function นี้ใน transaction 
// เดียวกับที่ทำการเปลี่ยนแปลงข้อมูลใน database 
// เพื่อให้แน่ใจว่า event จะถูกส่งไปเมื่อข้อมูลถูกเปลี่ยนแปลงจริงๆ
async function publishEvent(client, type, payload) {
  return client.outboxEvent.create({
    data: { eventId: randomUUID(), type, payload },
  });
}

module.exports = { publishEvent };
