const { randomUUID } = require("crypto");

// Write a domain event to the outbox. MUST be called with the same Prisma
// transaction client (`tx`) as the business change so the event is committed
// atomically with it — that's what makes delivery exactly mirror state.
async function publishEvent(client, type, payload) {
  return client.outboxEvent.create({
    data: { eventId: randomUUID(), type, payload },
  });
}

module.exports = { publishEvent };
