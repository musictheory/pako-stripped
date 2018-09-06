'use strict';


var fs     = require('fs');
var path   = require('path');
var assert = require('assert');

var walk = function(dir) {
    var results = [];
    var list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = dir + '/' + file;
        var stat = fs.statSync(file);
        if (stat && stat.isDirectory()) { 
            /* Recurse into a subdirectory */
            results = results.concat(walk(file));
        } else { 
            /* Is a file */
            results.push(file);
        }
    });
    return results;
}



// Load fixtures to test
// return: { 'filename1': content1, 'filename2': content2, ...}
//
function loadSamples(subdir) {
  var result = {};
  var dir = path.join(__dirname, subdir || 'samples');

  fs.readdirSync(dir).sort().forEach(function (sample) {
    var filepath = path.join(dir, sample),
        extname  = path.extname(filepath),
        basename = path.basename(filepath, extname),
        content  = new Uint8Array(fs.readFileSync(filepath));

    if (basename[0] === '_') { return; } // skip files with name, started with dash

    result[basename] = content;
  });

  // Include 10% of the files within node_modules for testing
  walk(path.join(__dirname, "..", "node_modules")).forEach(function(filepath) {
    if (Math.random() < 0.10) {
        var extname  = path.extname(filepath),
            basename = path.basename(filepath, extname),
            content  = new Uint8Array(fs.readFileSync(filepath));

            result[filepath] = content;
        }  
    });

  return result;
}


// Compare 2 buffers (can be Array, Uint8Array, Buffer).
//
function cmpBuf(a, b) {
    var ok = true;

  if (a.length !== b.length) {
      console.log(a.length + " !== " + b.length);
      ok = false;
  }

  for (var i = 0, l = a.length; i < l; i++) {
    if (a[i] !== b[i]) {
      console.log('pos: ' +i+ ' - ' + a[i].toString(16) + '/' + b[i].toString(16));
      ok = false;
    }
  }

  if (!ok) {
    console.log(a, b);
  }

  return ok;
}


function toBuffer(src) { return Buffer.from ? Buffer.from(src) : new Buffer(src); }


// Helper to test deflate/inflate with different options.
// Use zlib streams, because it's the only way to define options.
//
function testSingle(zlib_method, pako_method, data, options) {
  var zlib_options = Object.assign({}, options);

  // hack for testing negative windowBits
  if (zlib_options.windowBits < 0) { zlib_options.windowBits = -zlib_options.windowBits; }

  zlib_options.level = 3;
  options.level = 3;

  var zlib_result = zlib_method(toBuffer(data), zlib_options);
  var pako_result = pako_method(data, options);

  assert.ok(cmpBuf(zlib_result, toBuffer(pako_result)));

  // console.log("HERE");

  // assert.deepEqual(pako_result, zlib_result);
}


function testSamples(zlib_method, pako_method, samples, options) {

  Object.keys(samples).forEach(function (name) {
    var data = samples[name];

    testSingle(zlib_method, pako_method, data, options);
  });
}

exports.cmpBuf = cmpBuf;
exports.testSamples = testSamples;
exports.loadSamples = loadSamples;
