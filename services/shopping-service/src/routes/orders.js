const { Router } = require("express");
const ctrl = require("../controllers/orderController");

const router = Router();

router.post("/", ctrl.checkout);
router.get("/", ctrl.listOrders);
router.get("/:id", ctrl.getOrder);
router.patch("/:id/status", ctrl.updateStatus);

module.exports = router;
