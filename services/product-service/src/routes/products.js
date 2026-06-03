const { Router } = require("express");
const ctrl = require("../controllers/productController");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = Router();

// public catalog
router.get("/categories", ctrl.listCategories);
router.get("/", ctrl.list);
router.get("/:id", ctrl.getById);

// internal (used by shopping-service)
router.post("/bulk", ctrl.bulkByIds);

// admin management
router.post("/", authenticate, requireAdmin, ctrl.create);
router.put("/:id", authenticate, requireAdmin, ctrl.update);
router.delete("/:id", authenticate, requireAdmin, ctrl.remove);

module.exports = router;
