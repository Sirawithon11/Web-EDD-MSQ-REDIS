// Boot the user-service gRPC server.
const grpc = require("@grpc/grpc-js");
const { load } = require("./load");
const handlers = require("./handlers");

function startGrpcServer() {
  const proto = load("user.proto").user;
  const server = new grpc.Server();
  server.addService(proto.UserService.service, handlers);

  const addr = `0.0.0.0:${process.env.GRPC_PORT || 50051}`;
  server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error("gRPC bind failed:", err);
      process.exit(1);
    }
    console.log(`user-service gRPC listening on :${port}`);
  });
  return server;
}

module.exports = { startGrpcServer };
