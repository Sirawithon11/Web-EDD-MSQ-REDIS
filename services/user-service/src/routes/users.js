const { Router } = require("express");
const ctrl = require("../controllers/userController");
const { authenticate, requireAdmin } = require("../middleware/auth");

const router = Router();

// public
router.post("/register", ctrl.register);
router.post("/login", ctrl.login);

// authenticated
router.get("/me", authenticate, ctrl.me);

// admin only
router.get("/", authenticate, requireAdmin, ctrl.list);
router.get("/:id", authenticate, requireAdmin, ctrl.getById);

module.exports = router;
