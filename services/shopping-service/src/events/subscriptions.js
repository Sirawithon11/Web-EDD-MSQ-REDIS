// Outbound routing: which subscriber base-URLs each event TYPE this service
// produces should be delivered to. No broker — this static registry is how a
// producer knows its consumers.
const USER = process.env.USER_SERVICE_URL || "http://localhost:4001";
const PRODUCT = process.env.PRODUCT_SERVICE_URL || "http://localhost:4002";

module.exports = {
  // user-service updates per-user stats; product-service updates salesCount.
  "order.placed": [USER, PRODUCT],
  "order.status.changed": [USER, PRODUCT],
  "order.deleted": [USER, PRODUCT],
};
