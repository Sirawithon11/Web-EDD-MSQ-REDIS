// gRPC client for talking to product-service. This is the real east-west,
// service-to-service contract (checkout stock saga + bulk product fetch).
// It calls product-service's TYPED ProductService methods over gRPC.
const grpc = require("@grpc/grpc-js");
const { load } = require("./grpc/load");

const ADDR = process.env.PRODUCT_GRPC_ADDR || "localhost:50052";
const MAX = 16 * 1024 * 1024; // product payloads can carry base64 images

const proto = load("product.proto").product;
const client = new proto.ProductService(ADDR, grpc.credentials.createInsecure(), {
  "grpc.max_receive_message_length": MAX,
  "grpc.max_send_message_length": MAX,
});

// Promisify a unary call.
function unary(method, request) {
  return new Promise((resolve, reject) => {
    client[method](request, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

async function getProductsByIds(ids) {
  if (!ids.length) return [];
  const res = await unary("BulkByIds", { ids: ids.map(Number) });
  return res.products || [];
}

// Atomically decrement stock for purchased items. Throws on failure; the thrown
// Error carries `.status` so the caller can distinguish 409 (insufficient stock)
// from 404 (gone) — preserving the old HTTP-based contract.
async function decrementStock(items) {
  if (!items.length) return { updated: [] };
  try {
    return await unary("DecrementStock", {
      items: items.map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity) })),
    });
  } catch (err) {
    const mapped = new Error(err.details || err.message);
    mapped.status =
      err.code === grpc.status.FAILED_PRECONDITION ? 409 : err.code === grpc.status.NOT_FOUND ? 404 : 502;
    throw mapped;
  }
}

// Best-effort compensation: restore stock after a failed order. Never throws.
async function restock(items) {
  if (!items.length) return;
  try {
    await unary("Restock", {
      items: items.map((i) => ({ productId: Number(i.productId), quantity: Number(i.quantity) })),
    });
  } catch (_) {
    /* swallow — compensation is best-effort */
  }
}

module.exports = { getProductsByIds, decrementStock, restock };
