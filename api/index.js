// Vercel serverless entry point: the Express app handles every /api/* request.
// Static pages are served from the CDN out of the public/ build output.
module.exports = require('../server.js');
