const { Router } = require("express");
const ctrl = require("../controllers/productController");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = Router();

// public catalog
router.get("/categories", ctrl.listCategories);
router.get("/", ctrl.list);

// admin listing (includes inactive products) — must precede "/:id"
router.get("/admin", authenticate, requireAdmin, ctrl.adminList);
router.get("/audit-logs", authenticate, requireAdmin, ctrl.listAuditLogs);

router.get("/:id", ctrl.getById);

// internal (used by shopping-service)
router.post("/bulk", ctrl.bulkByIds);
router.post("/decrement-stock", ctrl.decrementStock);
router.post("/restock", ctrl.restock);

// admin management
router.post("/", authenticate, requireAdmin, ctrl.create);
router.put("/:id", authenticate, requireAdmin, ctrl.update);
router.delete("/:id", authenticate, requireAdmin, ctrl.remove);

module.exports = router;
