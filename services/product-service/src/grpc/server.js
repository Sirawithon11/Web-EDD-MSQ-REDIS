// Boot the product-service gRPC server.
const grpc = require("@grpc/grpc-js");
const { load } = require("./load");
const handlers = require("./handlers");

// Product images are base64 data-URLs (the old Express limit was 8mb); allow
// generous message sizes so create/update with an inline image still fits.
const MAX = 16 * 1024 * 1024;

function startGrpcServer() {
  const proto = load("product.proto").product;
  const server = new grpc.Server({
    "grpc.max_receive_message_length": MAX,
    "grpc.max_send_message_length": MAX,
  });
  server.addService(proto.ProductService.service, handlers);

  const addr = `0.0.0.0:${process.env.GRPC_PORT || 50052}`;
  server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error("gRPC bind failed:", err);
      process.exit(1);
    }
    console.log(`product-service gRPC listening on :${port}`);
  });
  return server;
}

module.exports = { startGrpcServer };
