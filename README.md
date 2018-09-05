pako-stripped
==========================================

This is a stripped-down version of [pako](https://github.com/nodeca/pako) which compresses to < 4kB.

Several features are removed to achieve this file size. What's left:

1. Raw deflate at `level=3, strategy=Z_DEFAULT_STRATEGY, windowBits=15, memLevel=8`
2. Input and output typed arrays with one call (no stream support)
3. Assumes Uint8Array/Uint16Array support.

Example
-------------

```javascript
var pako = require('pako');

// Deflate
//
var input = new Uint8Array();
//... fill input data here
var output = pako.deflateRaw(input);
```

Authors
-------

- Andrey Tupitsin [@anrd83](https://github.com/andr83)
- Vitaly Puzrin [@puzrin](https://github.com/puzrin)

Original implementation (in C):

- [zlib](http://zlib.net/) by Jean-loup Gailly and Mark Adler.


License
-------

- ZLIB - `/lib` content
- MIT - all other files
