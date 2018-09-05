// Top level file is just a mixin of submodules & constants
'use strict';

var assign    = require('./lib/utils/common').assign;
var deflate   = require('./lib/deflate');

var pako = {};

assign(pako, deflate);

module.exports = pako;
