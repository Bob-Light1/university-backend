module.exports = (allowedRoles = []) => {
  return (req, res, next) => {
    // JWT payload exposes a single `role`; tolerate a legacy `roles` array too.
    const userRoles = req.user?.roles || (req.user?.role ? [req.user.role] : []);

    const hasAccess = allowedRoles.some(role =>
      userRoles.includes(role)
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
      });
    }

    next();
  };
};
