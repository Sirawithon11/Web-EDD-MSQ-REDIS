require("dotenv").config();
const { startGrpcServer } = require("./grpc/server");
const { connectBus, startConsumer } = require("./events/bus");
const handlers = require("./events/handlers");

// user-service now speaks gRPC only. Kafka is unchanged: it still consumes
// shopping-service's order.* events to keep each user's ordersCount / totalSpent
// projection up to date.
async function main() {
  startGrpcServer();

  await connectBus();
  startConsumer({
    groupId: "user-service",
    topics: ["order.placed", "order.status.changed", "order.deleted"],
    handlers,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
