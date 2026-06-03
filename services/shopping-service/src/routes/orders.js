const { Router } = require("express");
const ctrl = require("../controllers/orderController");
const { requireAdmin } = require("../middleware/auth");

const router = Router();

router.post("/", ctrl.checkout);
router.get("/", ctrl.listOrders);

// admin-only — must precede "/:id" so they aren't captured as an order id
router.get("/all", requireAdmin, ctrl.adminListOrders);
router.get("/audit-logs", requireAdmin, ctrl.listAuditLogs);

router.get("/:id", ctrl.getOrder);
router.patch("/:id/status", requireAdmin, ctrl.updateStatus);
// authorization (admin any / user own) is enforced inside the controller
router.delete("/:id", ctrl.deleteOrder);

module.exports = router;
