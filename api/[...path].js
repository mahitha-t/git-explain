module.exports = async (req, res) => {
  const { default: app } = await import("../backend/server.js");
  return app(req, res);
};
