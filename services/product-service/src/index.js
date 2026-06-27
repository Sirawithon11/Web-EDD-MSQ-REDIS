require("dotenv").config();
const { startGrpcServer } = require("./grpc/server");
const { connectBus, startConsumer } = require("./events/bus");
const handlers = require("./events/handlers");

// product-service now speaks gRPC only (the gateway and shopping-service reach
// it over gRPC). Kafka is unchanged: it still publishes product.* and consumes
// order.* to keep each product's salesCount up to date.
async function main() {
  startGrpcServer();

  await connectBus();
  startConsumer({
    groupId: "product-service", // ชื่อ consumer Group ของ service นี้
    topics: ["order.placed", "order.status.changed", "order.deleted"],
    handlers,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
