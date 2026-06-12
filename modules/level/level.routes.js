const express = require("express");
const {
  createLevel,
  getLevels,
  getLevelById,
  updateLevel,
  deleteLevel,
  restoreLevel,
} = require("./controllers/level.controller");

const { authenticate, authorize } = require("../../shared/middleware/auth");

const router = express.Router();

const adminRoles = ["ADMIN",  "DIRECTOR", "CAMPUS_MANAGER"];
const staffRoles = ["ADMIN",  "DIRECTOR", "CAMPUS_MANAGER", "TEACHER"];

// Apply authentication to all routes
router.use(authenticate);

/**
 * @route   POST /api/level
 * @desc    Create a new level
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.post("/", authorize(adminRoles), createLevel);

/**
 * @route   GET /api/level
 * @desc    Get all levels
 * @access  All authenticated users
 */
router.get("/", getLevels);

/**
 * @route   GET /api/level/:id
 * @desc    Get a level by ID
 * @access  All authenticated users
 */
router.get("/:id", getLevelById);

/**
 * @route   PUT /api/level/update/:id
 * @desc    Update a level
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.put("/update/:id", authorize(adminRoles), updateLevel);

/**
 * @route   DELETE /api/level/delete/:id
 * @desc    Archive a level
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.delete("/delete/:id", authorize(adminRoles), deleteLevel);

/**
 * @route   PATCH /api/level/:id/restore
 * @desc    Restore an archived level
 * @access  CAMPUS_MANAGER, DIRECTOR
 */
router.patch("/:id/restore", authorize(adminRoles), restoreLevel);

module.exports = router;