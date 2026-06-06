// Outbound routing: which subscriber base-URLs each event TYPE this service
// produces should be delivered to. No broker — this static registry is how a
// producer knows its consumers.
const SHOPPING = process.env.SHOPPING_SERVICE_URL || "http://localhost:4003";

module.exports = {
  // shopping-service keeps a local ProductProjection up to date from these.
  // เก็บ domain events ที่จะส่งไปให้ service อื่นๆ (ในที่นี้คือ shopping-service) โดยระบุว่า event type ไหนจะส่งไปที่ service ไหนบ้าง
  "product.created": [SHOPPING],
  "product.updated": [SHOPPING],
  "product.stock.changed": [SHOPPING],
  "product.deleted": [SHOPPING],
};
