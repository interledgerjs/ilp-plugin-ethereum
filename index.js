'use strict'

// This is a hack to allow default and named CommonJS exports
const bundle = require('./build')
module.exports = bundle.default
for (let p in bundle) {
  if (!module.exports.hasOwnProperty(p)) {
    module.exports[p] = bundle[p]
  }
}
