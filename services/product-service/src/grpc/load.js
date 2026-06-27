// Load a .proto from the service's proto/ dir into a gRPC package object.
const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

function load(file) {
  const def = protoLoader.loadSync(path.join(__dirname, "..", "..", "proto", file), {
    keepCase: true, // keep proto field names as written (productId, not product_id)
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(def);
}

module.exports = { load };
