const path = require('path');

// Array-form aliases with a computed (path.resolve) replacement.
module.exports = {
  resolve: {
    alias: [{ find: '@data', replacement: path.resolve(__dirname, 'src/lib') }],
  },
};
