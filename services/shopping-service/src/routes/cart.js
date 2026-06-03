const { Router } = require("express");
const ctrl = require("../controllers/cartController");

const router = Router();

router.get("/", ctrl.getCart);
router.post("/items", ctrl.addItem);
router.put("/items/:itemId", ctrl.updateItem);
router.delete("/items/:itemId", ctrl.removeItem);

module.exports = router;
