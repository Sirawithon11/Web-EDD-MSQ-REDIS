// Boot the shopping-service gRPC server.
const grpc = require("@grpc/grpc-js");
const { load } = require("./load");
const handlers = require("./handlers");

function startGrpcServer() {
  const proto = load("shopping.proto").shopping;
  const server = new grpc.Server();
  server.addService(proto.ShoppingService.service, handlers);

  const addr = `0.0.0.0:${process.env.GRPC_PORT || 50053}`;
  server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error("gRPC bind failed:", err);
      process.exit(1);
    }
    console.log(`shopping-service gRPC listening on :${port}`);
  });
  return server;
}

module.exports = { startGrpcServer };
