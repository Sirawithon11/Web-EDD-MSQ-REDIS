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
// must precede "/:id" so "by-email" isn't captured as an :id
router.get("/by-email", authenticate, requireAdmin, ctrl.getByEmail);
router.get("/:id", authenticate, requireAdmin, ctrl.getById);

module.exports = router;
