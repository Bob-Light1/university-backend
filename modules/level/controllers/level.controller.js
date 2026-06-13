const levelRepo = require("../level.repository");

/**
 * Create a new level
 * @route POST /api/levels
 * @access ADMIN / DIRECTOR
 */
exports.createLevel = async (req, res) => {
  try {
    const { name, code, type, order, description } = req.body;

    // Basic validation
    if (!name || !code || !order) {
      return res.status(400).json({
        success: false,
        message: "Name, code and order are required",
      });
    }

    // Check for existing level with same code & type
    const exists = await levelRepo.findByCodeAndType(code, type);
    if (exists) {
      return res.status(409).json({
        success: false,
        message: "A level with this code already exists",
      });
    }

    const level = await levelRepo.create({
      name,
      code,
      type,
      order,
      description,
    });

    res.status(201).json({
      success: true,
      data: level,
    });
  } catch (error) {
    console.error("Create level error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create level",
    });
  }
};

/**
 * Get all active levels
 * Supports filtering by type
 * @route GET /api/levels
 * @access AUTHENTICATED
 */
exports.getLevels = async (req, res) => {
  try {
    const { type } = req.query;

    const levels = await levelRepo.listActive({ type });

    res.status(200).json({
      success: true,
      count: levels.length,
      data: levels,
    });
  } catch (error) {
    console.error("Get levels error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch levels",
    });
  }
};

/**
 * Get a single level by ID
 * @route GET /api/levels/:id
 * @access AUTHENTICATED
 */
exports.getLevelById = async (req, res) => {
  try {
    const level = await levelRepo.findById(req.params.id);

    if (!level) {
      return res.status(404).json({
        success: false,
        message: "Level not found",
      });
    }

    res.status(200).json({
      success: true,
      data: level,
    });
  } catch (error) {
    console.error("Get level by ID error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch level",
    });
  }
};

/**
 * Update level information
 * @route PUT /api/levels/:id
 * @access ADMIN / DIRECTOR
 */
exports.updateLevel = async (req, res) => {
  try {
    const { name, code, type, order, description, status } = req.body;

    // Build the set of fields actually provided (sémantique "update partiel").
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (code !== undefined) fields.code = code;
    if (type !== undefined) fields.type = type;
    if (order !== undefined) fields.order = order;
    if (description !== undefined) fields.description = description;
    if (status !== undefined) fields.status = status;

    const level = await levelRepo.updateById(req.params.id, fields);
    if (!level) {
      return res.status(404).json({
        success: false,
        message: "Level not found",
      });
    }

    res.status(200).json({
      success: true,
      data: level,
    });
  } catch (error) {
    console.error("Update level error:", error);

    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Duplicate level code",
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update level",
    });
  }
};

/**
 * Soft delete a level (archive)
 * @route DELETE /api/levels/:id
 * @access ADMIN / DIRECTOR
 */
exports.deleteLevel = async (req, res) => {
  try {
    const level = await levelRepo.setStatus(req.params.id, "archived");

    if (!level) {
      return res.status(404).json({
        success: false,
        message: "Level not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Level archived successfully",
    });
  } catch (error) {
    console.error("Delete level error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete level",
    });
  }
};

exports.restoreLevel = async (req, res) => {
  try {
    const level = await levelRepo.findById(req.params.id);

    if (!level) {
      return res.status(404).json({ success: false, message: "Level not found" });
    }

    if (level.status !== 'archived') {
      return res.status(400).json({ success: false, message: "Level is not archived" });
    }

    await levelRepo.setStatus(req.params.id, 'active');

    res.status(200).json({ success: true, message: "Level restored successfully" });
  } catch (error) {
    console.error("Restore level error:", error);
    res.status(500).json({ success: false, message: "Failed to restore level" });
  }
};
