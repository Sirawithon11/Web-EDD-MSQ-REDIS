// Writes one append-only audit row for an admin action on an order.
// Pass a Prisma client OR a transaction client as `client` so the log can be
// committed atomically with the action it records.
async function writeAudit(client, req, { action, entityId, details }) {
  return client.auditLog.create({
    data: {
      actorId: req.user?.id ?? 0,
      actorEmail: req.user?.email ?? "unknown",
      action,
      entity: "ORDER",
      entityId: entityId ?? null,
      details: details ?? undefined,
    },
  });
}

module.exports = { writeAudit };
