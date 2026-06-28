// gRPC clients the gateway uses to reach the three backend services. The gateway
// is now a REST -> gRPC translator: it keeps the public REST surface the browser
// expects, but every backend hop is gRPC.
const path = require("path");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const MAX = 16 * 1024 * 1024; // product payloads can carry base64 images

function load(file, pkg) { // function สำหรับอ่าน ไฟล์ .photo เพื่อสร้าง stub
  const def = protoLoader.loadSync(path.join(__dirname, "..", "proto", file), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(def)[pkg];
}

const userProto = load("user.proto", "user"); // สร้าง stub
const productProto = load("product.proto", "product");
const shoppingProto = load("shopping.proto", "shopping");

const opts = { "grpc.max_receive_message_length": MAX, "grpc.max_send_message_length": MAX }; // config ข้อมูลที่จะส่งผ่าน gRPC
const creds = grpc.credentials.createInsecure(); //ป้องกันการ hack การส่งข้อมูลผ่าน gRPC

const userClient = new userProto.UserService(process.env.USER_GRPC_ADDR || "localhost:50051", creds, opts); // นำ stub client เชื่อมกับ stub server
const productClient = new productProto.ProductService(process.env.PRODUCT_GRPC_ADDR || "localhost:50052", creds, opts);
const shoppingClient = new shoppingProto.ShoppingService(process.env.SHOPPING_GRPC_ADDR || "localhost:50053", creds, opts);

// JWT จาก Rest ส่งผ่าน gRPC ผ่านทางนี้แทน
function metaFrom(req) {
  const md = new grpc.Metadata();
  if (req.headers.authorization) md.set("authorization", req.headers.authorization);
  return md;
}

function unary(client, method, request, md) {
  return new Promise((resolve, reject) => {
    let response;
    let error;
    let settled = false;
    const call = client[method](request, md || new grpc.Metadata(), (err, res) => {
      if (err) error = err;
      else response = res;
    });
    call.on("error", () => {}); // handled via callback + status; avoid unhandled 'error'
    call.on("status", (status) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve({ response, trailers: status.metadata });
    });
  });
}

//  นำ status code จาก gRPC เปลี่ยนเป็น status code ของ Rest ไป แสดงที่ Browser
const STATUS_MAP = {
  [grpc.status.INVALID_ARGUMENT]: 400,
  [grpc.status.UNAUTHENTICATED]: 401,
  [grpc.status.PERMISSION_DENIED]: 403,
  [grpc.status.NOT_FOUND]: 404,
  [grpc.status.ALREADY_EXISTS]: 409,
  [grpc.status.FAILED_PRECONDITION]: 409,
  [grpc.status.UNAVAILABLE]: 503,
  [grpc.status.DEADLINE_EXCEEDED]: 504,
};

function sendError(res, err) {
  const code = STATUS_MAP[err.code] || 500;
  res.status(code).json({ message: err.details || err.message || "Gateway error" });
}

// Run a gRPC call and translate the reply back into an HTTP/JSON response,
// preserving the X-Cache header and the original success status code (201/204).
async function forward(req, res, client, method, request, { status = 200 } = {}) {
  try {
    const { response, trailers } = await unary(client, method, request, metaFrom(req));
    const xcache = trailers && trailers.get("x-cache");
    if (xcache && xcache[0]) res.setHeader("X-Cache", xcache[0]);

    // JsonReply carries `json`; Empty replies carry nothing -> 204.
    if (response && response.json !== undefined) {
      return res.status(status).json(JSON.parse(response.json || "null"));
    }
    return res.status(status === 200 ? 204 : status).end();
  } catch (err) {
    sendError(res, err);
  }
}

module.exports = { userClient, productClient, shoppingClient, forward, sendError, unary, metaFrom };
