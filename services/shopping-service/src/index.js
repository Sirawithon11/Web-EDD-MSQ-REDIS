require("dotenv").config();
const { startGrpcServer } = require("./grpc/server");
const { connectBus, startConsumer } = require("./events/bus");
const handlers = require("./events/handlers");

// shopping-service now speaks gRPC only (the gateway reaches it over gRPC, and it
// reaches product-service over gRPC for the checkout saga). Kafka is unchanged:
// it publishes order.* and consumes product.* to keep the ProductProjection read
// model in sync.
async function main() {
  startGrpcServer();

  await connectBus();
  startConsumer({
    groupId: "shopping-service",
    topics: ["product.created", "product.updated", "product.stock.changed", "product.deleted"],
    handlers,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
