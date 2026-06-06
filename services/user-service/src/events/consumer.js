// Inbound event endpoint: the "subscriber" half of the pattern. Other services'
// relays POST here. Delivery is at-least-once, so we dedupe via the inbox and
// process the handler in the SAME transaction as the inbox insert — both commit
// or neither does, giving effectively-once processing.
const { Router } = require("express");
const prisma = require("../prisma");
const handlers = require("./handlers");

const SECRET = process.env.EVENT_SECRET || "dev-event-secret";
const router = Router();

router.post("/", async (req, res) => {
  if ((req.headers["x-event-secret"] || "") !== SECRET) {
    return res.status(401).json({ message: "bad event secret" });
  }

  const { id, type, payload } = req.body || {};
  if (!id || !type) return res.status(400).json({ message: "id and type are required" });

  const handler = handlers[type];

  try {
    await prisma.$transaction(async (tx) => {
      // Unique PK on eventId — a duplicate delivery throws P2002 and we bail.
      await tx.inboxEvent.create({ data: { eventId: id, type } });
      if (handler) await handler(tx, payload || {});
    });
  } catch (err) {
    if (err.code === "P2002") {
      // Already processed — ack so the sender stops retrying.
      return res.status(200).json({ status: "duplicate" });
    }
    // Handler failed: nothing was committed (inbox row rolled back), so a retry
    // will reprocess cleanly. Signal failure so the sender retries.
    console.error(`[consumer] handler "${type}" failed:`, err);
    return res.status(500).json({ message: "handler failed" });
  }

  res.status(200).json({ status: handler ? "ok" : "ignored" });
});

module.exports = router;
