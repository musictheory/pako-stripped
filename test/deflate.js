/*global describe, it*/


'use strict';


var zlib = require('zlib');

var pako    = require('../index');
var helpers = require('./helpers');
var testSamples = helpers.testSamples;


var samples = helpers.loadSamples();


describe('Deflate defaults', function () {
  it('deflate', function () {
    testSamples(zlib.deflateSync, pako.deflate, samples, {});
  });

});
