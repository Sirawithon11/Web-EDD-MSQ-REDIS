// Outbound routing: which subscriber base-URLs each event TYPE this service
// produces should be delivered to. No broker — this static registry is how a
// producer knows its consumers. Types with an empty array are still recorded in
// the outbox and marked published (fan-out of zero), ready for future wiring.

module.exports = {
  // No service consumes this yet — emitted for completeness / future use
  // (e.g. a websocket gateway or a welcome-email service).
  "user.registered": [],
};
