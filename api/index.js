const app = require('../index.js');
const serverless = require('serverless-http');
module.exports = serverless(app);

