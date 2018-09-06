'use strict';

// This file is a reduction of:
// https://github.com/nodeca/pako/blob/master/lib/zlib/deflate.js

// (C) 1995-2013 Jean-loup Gailly and Mark Adler
// (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin
//
// This software is provided 'as-is', without any express or implied
// warranty. In no event will the authors be held liable for any damages
// arising from the use of this software.
//
// Permission is granted to anyone to use this software for any purpose,
// including commercial applications, and to alter it and redistribute it
// freely, subject to the following restrictions:
//
// 1. The origin of this software must not be misrepresented; you must not
//   claim that you wrote the original software. If you use this software
//   in a product, an acknowledgment in the product documentation would be
//   appreciated but is not required.
// 2. Altered source versions must be plainly marked as such, and must not be
//   misrepresented as being the original software.
// 3. This notice may not be removed or altered from any source distribution.

/* Return codes for the compression/decompression functions. Negative values
 * are errors, positive values are used for special but normal events.
 */
var Z_OK            = 0;
var Z_STREAM_END    = 1;

var SCAN_TREE = 0;
var SEND_TREE = 1;

var LENGTH_CODES  = 29;
/* number of length codes, not counting the special END_BLOCK code */
var LITERALS      = 256;
/* number of literal bytes 0..255 */
var L_CODES       = LITERALS + 1 + LENGTH_CODES;
/* number of Literal or Length codes, including the END_BLOCK code */
var D_CODES       = 30;
/* number of distance codes */
var BL_CODES      = 19;
/* number of codes used to transfer the bit lengths */
var HEAP_SIZE     = 2 * L_CODES + 1;
/* maximum heap size */
var MAX_BITS  = 15;
/* All codes must not exceed MAX_BITS bits */

var MIN_MATCH = 3;
var MAX_MATCH = 258;
var MIN_LOOKAHEAD = (MAX_MATCH + MIN_MATCH + 1);

var BS_NEED_MORE      = 1; /* block not completed, need more input or more output */
var BS_BLOCK_DONE     = 2; /* block flush performed */
var BS_FINISH_STARTED = 3; /* finish started, need only more output at next deflate */
var BS_FINISH_DONE    = 4; /* finish done, accept no more input or output */

var Buf_size      = 16;


function zero(buf)
{
    var len = buf.length;
    while (--len >= 0) { buf[len] = 0; }
}


function arraySet(dest, src, src_offs, len, dest_offs)
{
    dest.set(src.subarray(src_offs, src_offs + len), dest_offs);
}


var MAX_BL_BITS = 7;
/* Bit length codes must not exceed MAX_BL_BITS bits */

var END_BLOCK   = 256;
/* end of block literal code */

var REP_3_6     = 16;
/* repeat previous bit length 3-6 times (2 bits of repeat count) */

var REPZ_3_10   = 17;
/* repeat a zero length 3-10 times  (3 bits of repeat count) */

var REPZ_11_138 = 18;
/* repeat a zero length 11-138 times  (7 bits of repeat count) */

var extra_lbits =   /* extra bits for each length code */
  [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];

var extra_dbits =   /* extra bits for each distance code */
  [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

var extra_blbits =  /* extra bits for each bit length code */
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,3,7];

var bl_order =
  [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];


// These use to be on state, and are now constants
var s_lit_bufsize = 1 << 14;
var s_l_buf = 3 * s_lit_bufsize;
var s_d_buf = 1 * s_lit_bufsize;
var s_prev_length = MIN_MATCH - 1;

var s_hash_size = 1 << 15;
var s_hash_mask = s_hash_size - 1;

var s_w_size = 1 << 15;
var s_w_mask = s_w_size - 1;


/* The lengths of the bit length codes are sent in order of decreasing
 * probability, to avoid transmitting the lengths for unused bit length codes.
 */


// We pre-fill arrays with 0 to avoid uninitialized gaps

var DIST_CODE_LEN = 512; /* see definition of array dist_code below */

// !!!! Use flat array instead of structure, Freq = i*2, Len = i*2+1
var static_ltree  = new Array((L_CODES + 2) * 2);
zero(static_ltree);
/* The static literal tree. Since the bit lengths are imposed, there is no
 * need for the L_CODES extra codes used during heap construction. However
 * The codes 286 and 287 are needed to build a canonical tree (see _tr_init
 * below).
 */

var static_dtree  = new Array(D_CODES * 2);
zero(static_dtree);
/* The static distance tree. (Actually a trivial tree since all codes use
 * 5 bits.)
 */

var _dist_code    = new Array(DIST_CODE_LEN);
zero(_dist_code);
/* Distance codes. The first 256 values correspond to the distances
 * 3 .. 258, the last 256 values correspond to the top 8 bits of
 * the 15 bit distances.
 */

var _length_code  = new Array(MAX_MATCH - MIN_MATCH + 1);
zero(_length_code);
/* length code for each normalized match length (0 == MIN_MATCH) */

var base_length   = new Array(LENGTH_CODES);
zero(base_length);
/* First normalized length for each code (0 = MIN_MATCH) */

var base_dist     = new Array(D_CODES);
zero(base_dist);
/* First normalized distance for each code (0 = distance of 1) */


var static_l_desc;
var static_d_desc;
var static_bl_desc;



function makeStaticTreeDesc(static_tree, extra_bits, extra_base, elems, max_length)
{
    return {
        _static_tree: static_tree,
        _extra_bits:  extra_bits,
        _extra_base:  extra_base,
        _elems:       elems,
        _max_length:  max_length,
        _has_stree:   static_tree && static_tree.length
    };
}


function makeTreeDesc(dyn_tree, stat_desc)
{
    return {
        _dyn_tree: dyn_tree,
        _max_code: 0,
        _stat_desc: stat_desc
    };
}


function d_code(dist)
{
    return dist < 256 ? _dist_code[dist] : _dist_code[256 + (dist >>> 7)];
}


function put_short(s, w)
{
    s._pending_buf[s._pending++] = (w) & 0xff;
    s._pending_buf[s._pending++] = (w >>> 8) & 0xff;
}


function send_bits(s, value, length)
{
    if (s._bi_valid > (Buf_size - length)) {
        s._bi_buf |= (value << s._bi_valid) & 0xffff;
        put_short(s, s._bi_buf);
        s._bi_buf = value >> (Buf_size - s._bi_valid);
        s._bi_valid += length - Buf_size;
    } else {
        s._bi_buf |= (value << s._bi_valid) & 0xffff;
        s._bi_valid += length;
    }
}


function send_code(s, c, tree)
{
    send_bits(s, tree[c * 2], tree[c * 2 + 1]);
}


function bi_reverse(code, len)
{
    var res = 0;

    do {
        res |= code & 1;
        code >>>= 1;
        res <<= 1;
    } while (--len > 0);

    return res >>> 1;
}


function gen_bitlen(s, desc)
{
    var tree       = desc._dyn_tree;
    var max_code   = desc._max_code;
    var stree      = desc._stat_desc._static_tree;
    var has_stree  = desc._stat_desc._has_stree;
    var extra      = desc._stat_desc._extra_bits;
    var base       = desc._stat_desc._extra_base;
    var max_length = desc._stat_desc._max_length;

    var _bl_count = s._bl_count;

    var h;
    var n, m;
    var bits;
    var xbits;
    var f;
    var overflow = 0;

    for (bits = 0; bits <= MAX_BITS; bits++) {
        _bl_count[bits] = 0;
    }

    tree[s._heap[s._heap_max] * 2 + 1] = 0; /* root of the heap */

    for (h = s._heap_max + 1; h < HEAP_SIZE; h++) {
        n = s._heap[h];
        bits = tree[tree[n * 2 + 1] * 2 + 1] + 1;

        if (bits > max_length) {
            bits = max_length;
            overflow++;
        }
        tree[n * 2 + 1] = bits;

        if (n > max_code) { continue; }

        _bl_count[bits]++;
        xbits = 0;

        if (n >= base) {
            xbits = extra[n - base];
        }

        f = tree[n * 2];
        
        s._opt_len += f * (bits + xbits);
        if (has_stree) {
            s._static_len += f * (stree[n * 2 + 1] + xbits);
        }
    }

    if (!overflow) { return; }

    do {
        bits = max_length - 1;
        while (!_bl_count[bits]) { bits--; }
        _bl_count[bits]--;
        _bl_count[bits + 1] += 2;
        _bl_count[max_length]--;
        overflow -= 2;
    } while (overflow > 0);

    for (bits = max_length; bits != 0; bits--) {
        n = _bl_count[bits];

        while (n) {
            m = s._heap[--h];
            if (m > max_code) { continue; }

            if (tree[m * 2 + 1] !== bits) {
                s._opt_len += (bits - tree[m * 2 + 1]) * tree[m * 2];
                tree[m * 2 + 1] = bits;
            }

            n--;
        }
    }
}


function gen_codes(tree, max_code, bl_count)
{
    var next_code = new Array(MAX_BITS + 1);
    var code = 0;

    for (var bits = 1; bits <= MAX_BITS; bits++) {
        next_code[bits] = code = (code + bl_count[bits - 1]) << 1;
    }

    for (var n = 0;  n <= max_code; n++) {
        var len = tree[n * 2 + 1];
        if (!len) { continue; }
        tree[n * 2] = bi_reverse(next_code[len]++, len);
    }
}


function tr_static_init()
{
    var n;
    var bits;
    var length = 0;
    var code;
    var dist;
    var bl_count = new Array(MAX_BITS + 1);

    for (code = 0; code < LENGTH_CODES - 1; code++) {
        base_length[code] = length;
    
        for (n = 0; n < (1 << extra_lbits[code]); n++) {
            _length_code[length++] = code;
        }
    }

    _length_code[length - 1] = code;

    dist = 0;

    for (code = 0; code < 16; code++) {
        base_dist[code] = dist;
        for (n = 0; n < (1 << extra_dbits[code]); n++) {
            _dist_code[dist++] = code;
        }
    }

    dist >>= 7;
    for (; code < D_CODES; code++) {
        base_dist[code] = dist << 7;

        for (n = 0; n < (1 << (extra_dbits[code] - 7)); n++) {
            _dist_code[256 + dist++] = code;
        }
    }

    for (bits = 0; bits <= MAX_BITS; bits++) {
        bl_count[bits] = 0;
    }

    n = 0;
    while (n <= 143) {
        static_ltree[n * 2 + 1] = 8;
        n++;
        bl_count[8]++;
    }

    while (n <= 255) {
        static_ltree[n * 2 + 1] = 9;
        n++;
        bl_count[9]++;
    }

    while (n <= 279) {
        static_ltree[n * 2 + 1] = 7;
        n++;
        bl_count[7]++;
    }

    while (n <= 287) {
        static_ltree[n * 2 + 1] = 8;
        n++;
        bl_count[8]++;
    }

    gen_codes(static_ltree, L_CODES + 1, bl_count);

    for (n = 0; n < D_CODES; n++) {
        static_dtree[n * 2 + 1] = 5;
        static_dtree[n * 2] = bi_reverse(n, 5);
    }

    static_l_desc  = makeStaticTreeDesc(static_ltree, extra_lbits,  LITERALS + 1, L_CODES,  MAX_BITS);
    static_d_desc  = makeStaticTreeDesc(static_dtree, extra_dbits,  0,            D_CODES,  MAX_BITS);
    static_bl_desc = makeStaticTreeDesc(new Array(0), extra_blbits, 0,            BL_CODES, MAX_BL_BITS);
}


function init_block(s)
{
    var n;

    for (n = 0; n < L_CODES;  n++) { s._dyn_ltree[n * 2] = 0; }
    for (n = 0; n < D_CODES;  n++) { s._dyn_dtree[n * 2] = 0; }
    for (n = 0; n < BL_CODES; n++) { s._bl_tree[n * 2] = 0; }

    s._dyn_ltree[END_BLOCK * 2] = 1;
    s._opt_len = s._static_len = 0;
    s._last_lit = 0;
}


function bi_windup(s)
{
    if (s._bi_valid > 8) {
        put_short(s, s._bi_buf);
    } else if (s._bi_valid > 0) {
        s._pending_buf[s._pending++] = s._bi_buf;
    }

    s._bi_buf = 0;
    s._bi_valid = 0;
}


function smaller(tree, n, m, depth)
{
    var _n2 = n * 2;
    var _m2 = m * 2;

    return (tree[_n2] < tree[_m2] ||
         (tree[_n2] == tree[_m2] && depth[n] <= depth[m]));
}


function pqdownheap(s, tree, k)
{
    var v = s._heap[k];
    var j = k << 1;  /* left son of k */

    while (j <= s._heap_len) {
        if (j < s._heap_len &&
              smaller(tree, s._heap[j + 1], s._heap[j], s._depth)) {
              j++;
        }

        if (smaller(tree, v, s._heap[j], s._depth)) { break; }

        s._heap[k] = s._heap[j];
        k = j;

        j <<= 1;
    }

    s._heap[k] = v;
}


function compress_block(s, ltree, dtree)
{
    var dist;
    var lc;
    var lx = 0;
    var code;
    var extra;

    if (s._last_lit) {
        do {
            dist = (s._pending_buf[s_d_buf + lx * 2] << 8) | (s._pending_buf[s_d_buf + lx * 2 + 1]);
            lc = s._pending_buf[s_l_buf + lx];
            lx++;

            if (!dist) {
                send_code(s, lc, ltree);
            } else {
                code = _length_code[lc];
                send_code(s, code + LITERALS + 1, ltree);
                extra = extra_lbits[code];

                if (extra) {
                    lc -= base_length[code];
                    send_bits(s, lc, extra);
                }
            
                dist--;
                code = d_code(dist);

                send_code(s, code, dtree);
                extra = extra_dbits[code];
                if (extra) {
                    dist -= base_dist[code];
                    send_bits(s, dist, extra);
                }
            }
        } while (lx < s._last_lit);
    }

    send_code(s, END_BLOCK, ltree);
}


function build_tree(s, desc)
{
    var tree      = desc._dyn_tree;
    var stree     = desc._stat_desc._static_tree;
    var has_stree = desc._stat_desc._has_stree;
    var elems     = desc._stat_desc._elems;
    var n, m;
    var max_code = -1;
    var node;

    var heap  = s._heap;
    var depth = s._depth;

    s._heap_len = 0;
    s._heap_max = HEAP_SIZE;

    for (n = 0; n < elems; n++) {
        if (tree[n * 2]) {
            heap[++s._heap_len] = max_code = n;
            depth[n] = 0;

        } else {
            tree[n * 2 + 1] = 0;
        }
    }

    while (s._heap_len < 2) {
        node = heap[++s._heap_len] = (max_code < 2 ? ++max_code : 0);
        tree[node * 2] = 1;
        depth[node] = 0;
        s._opt_len--;

        if (has_stree) {
            s._static_len -= stree[node * 2 + 1];
        }
    }

    desc._max_code = max_code;

    for (n = (s._heap_len >> 1); n >= 1; n--) {
        pqdownheap(s, tree, n);
    }

    node = elems;

    do {
        n = heap[1];
        heap[1] = heap[s._heap_len--];
        pqdownheap(s, tree, 1);

        m = s._heap[1];

        heap[--s._heap_max] = n;
        heap[--s._heap_max] = m;

        tree[node * 2] = tree[n * 2] + tree[m * 2];
        depth[node] = (depth[n] >= depth[m] ? depth[n] : depth[m]) + 1;
        tree[n * 2 + 1] = tree[m * 2 + 1] = node;

        heap[1] = node++;
        pqdownheap(s, tree, 1);
    } while (s._heap_len >= 2);

    heap[--s._heap_max] = heap[1];

    gen_bitlen(s, desc);

    gen_codes(tree, max_code, s._bl_count);
}


function scan_or_send_tree(s, tree, max_code, type)
{
    var n;                     /* iterates over all tree elements */
    var prevlen = -1;          /* last emitted length */
    var curlen;                /* length of current code */

    var nextlen = tree[0 * 2 + 1]; /* length of next code */

    var count = 0;             /* repeat count of the current code */
    var max_count = 7;         /* max repeat count */
    var min_count = 4;         /* min repeat count */

    var bl_tree = s._bl_tree;

    if (!nextlen) {
        max_count = 138;
        min_count = 3;
    }

    if (type == SCAN_TREE) tree[(max_code + 1) * 2 + 1] = 0xffff; /* guard */

    for (n = 0; n <= max_code; n++) {
        curlen = nextlen;
        nextlen = tree[(n + 1) * 2 + 1];

        if (++count < max_count && curlen == nextlen) {
            continue;
        } else if (type == SCAN_TREE) {
            if (count < min_count) {
                bl_tree[curlen * 2] += count;
            } else if (curlen) {
                if (curlen !== prevlen) { s._bl_tree[curlen * 2]++; }
                bl_tree[REP_3_6 * 2]++;
            } else if (count <= 10) {
                bl_tree[REPZ_3_10 * 2]++;
            } else {
                bl_tree[REPZ_11_138 * 2]++;
            }
        } else /*{*/
            if (count < min_count) {
                do { send_code(s, curlen, bl_tree); } while (--count);

            } else if (curlen) {
                if (curlen !== prevlen) {
                    send_code(s, curlen, bl_tree);
                    count--;
                }

                send_code(s, REP_3_6, bl_tree);
                send_bits(s, count - 3, 2);

            } else if (count <= 10) {
                send_code(s, REPZ_3_10, bl_tree);
                send_bits(s, count - 3, 3);

            } else {
                send_code(s, REPZ_11_138, bl_tree);
                send_bits(s, count - 11, 7);
            }
        /*}*/

        count = 0;
        prevlen = curlen;

        if (nextlen == 0) {
            max_count = 138;
            min_count = 3;

        } else if (curlen == nextlen) {
            max_count = 6;
            min_count = 3;

        } else {
            max_count = 7;
            min_count = 4;
        }
    }
}


var static_init_done = false;


function _tr_stored_block(s, buf, stored_len, last)
{
    send_bits(s, /*(STORED_BLOCK << 1) + */ (last ? 1 : 0), 3);

    bi_windup(s);
    put_short(s, stored_len);
    put_short(s, ~stored_len);

    arraySet(s._pending_buf, s._window, buf, stored_len, s._pending);

    s._pending += stored_len;
}


function _tr_tally(s, dist, lc)
{
    s._pending_buf[s_d_buf + s._last_lit * 2]     = (dist >>> 8) & 0xff;
    s._pending_buf[s_d_buf + s._last_lit * 2 + 1] = dist & 0xff;

    s._pending_buf[s_l_buf + s._last_lit] = lc & 0xff;
    s._last_lit++;

    if (dist == 0) {
        s._dyn_ltree[lc * 2]++;
    } else {
        dist--;

        s._dyn_ltree[(_length_code[lc] + LITERALS + 1) * 2]++;
        s._dyn_dtree[d_code(dist) * 2]++;
    }

    return (s._last_lit == s_lit_bufsize - 1);
}


function flush_pending(s)
{
    var len = s._pending;
    if (len > s._avail_out) {
        len = s._avail_out;
    }
    if (!len) return;

    arraySet(s._output, s._pending_buf, s._pending_out, len, s._next_out);
    s._next_out += len;
    s._pending_out += len;
    s._avail_out -= len;
    s._pending -= len;
    
    if (s._pending == 0) {
        s._pending_out = 0;
    }
}


function flush_block_only(s, last)
{
    var buf = s._block_start < 0 ? -1 : s._block_start;
    var stored_len = s._strstart - s._block_start;
    var opt_lenb, static_lenb;
    var max_blindex;

    build_tree(s, s._l_desc);
    build_tree(s, s._d_desc);

    scan_or_send_tree(s, s._dyn_ltree, s._l_desc._max_code, SCAN_TREE);
    scan_or_send_tree(s, s._dyn_dtree, s._d_desc._max_code, SCAN_TREE);

    build_tree(s, s._bl_desc);

    for (max_blindex = BL_CODES - 1; max_blindex >= 3; max_blindex--) {
        if (s._bl_tree[bl_order[max_blindex] * 2 + 1] !== 0) {
            break;
        }
    }

    s._opt_len += 3 * (max_blindex + 1) + 5 + 5 + 4;

    opt_lenb = (s._opt_len + 3 + 7) >>> 3;
    static_lenb = (s._static_len + 3 + 7) >>> 3;

    if (static_lenb <= opt_lenb) { opt_lenb = static_lenb; }

    if ((stored_len + 4 <= opt_lenb) && (buf !== -1)) {
        _tr_stored_block(s, buf, stored_len, last);
    } else if (static_lenb == opt_lenb) {
        send_bits(s, (1/*STATIC_TREES*/ << 1) + (last ? 1 : 0), 3);
        compress_block(s, static_ltree, static_dtree);
    } else {
        send_bits(s, (2/*DYN_TREES*/ << 1) + (last ? 1 : 0), 3);

        var lcodes = s._l_desc._max_code;
        var dcodes = s._d_desc._max_code;

        send_bits(s, lcodes - 256, 5);
        send_bits(s, dcodes, 5);
        send_bits(s, max_blindex - 3,  4);

        for (var rank = 0; rank <= max_blindex; rank++) {
            send_bits(s, s._bl_tree[bl_order[rank] * 2 + 1], 3);
        }

        scan_or_send_tree(s, s._dyn_ltree, lcodes, SEND_TREE);
        scan_or_send_tree(s, s._dyn_dtree, dcodes, SEND_TREE);

        compress_block(s, s._dyn_ltree, s._dyn_dtree);
    }

    init_block(s);

    if (last) {
        bi_windup(s);
    }

    s._block_start = s._strstart;
    flush_pending(s);
}


function read_buf(s, buf, start, size)
{
    var len = s._avail_in;

    if (len > size) { len = size; }
    if (!len) { return 0; }

    s._avail_in -= len;

    arraySet(buf, s._input, s._next_in, len, start);

    s._next_in += len;

    return len;
}


function longest_match(s, cur_match)
{
    var chain_length = 32;
    var scan = s._strstart;
    var match;
    var len;
    var best_len = s_prev_length;
    var nice_match = 32;

    var limit = (s._strstart > (s_w_size - MIN_LOOKAHEAD)) ?
        s._strstart - (s_w_size - MIN_LOOKAHEAD) : 0;

    var _win = s._window;

    var wmask = s_w_mask;
    var prev  = s._prev;

    var strend = s._strstart + MAX_MATCH;
    var scan_end1  = _win[scan + best_len - 1];
    var scan_end   = _win[scan + best_len];

    if (s_prev_length >= 4) {
        chain_length >>= 2;
    }

    if (nice_match > s._lookahead) { nice_match = s._lookahead; }

    do {
        match = cur_match;

        if (_win[match + best_len]     != scan_end  ||
            _win[match + best_len - 1] != scan_end1 ||
            _win[match]                != _win[scan] ||
            _win[++match]              != _win[scan + 1])
        {
            continue;
        }

        scan += 2;
        match++;
    
        do {
          /*jshint noempty:false*/
        } while (_win[++scan] == _win[++match] && _win[++scan] == _win[++match] &&
                 _win[++scan] == _win[++match] && _win[++scan] == _win[++match] &&
                 _win[++scan] == _win[++match] && _win[++scan] == _win[++match] &&
                 _win[++scan] == _win[++match] && _win[++scan] == _win[++match] &&
                 scan < strend);

        len = MAX_MATCH - (strend - scan);
        scan = strend - MAX_MATCH;

        if (len > best_len) {
            s._match_start = cur_match;
            best_len = len;

            if (len >= nice_match) {
                break;
            }

            scan_end1  = _win[scan + best_len - 1];
            scan_end   = _win[scan + best_len];
        }
    } while ((cur_match = prev[cur_match & wmask]) > limit && --chain_length);

    if (best_len <= s._lookahead) {
        return best_len;
    }

    return s._lookahead;
}


function fill_window(s)
{
    var _w_size = s_w_size;
    var p, n, m, more, str;

    var head = s._head;
    var prev = s._prev;

    do {
        more = s._window.length - s._lookahead - s._strstart;

        if (s._strstart >= _w_size + (_w_size - MIN_LOOKAHEAD)) {
            arraySet(s._window, s._window, _w_size, _w_size, 0);
            s._match_start -= _w_size;
            s._strstart -= _w_size;
            s._block_start -= _w_size;

            n = s_hash_size;
            p = n;

            do {
                m = head[--p];
                head[p] = (m >= _w_size ? m - _w_size : 0);
            } while (--n);

            n = _w_size;
            p = n;

            do {
                m = prev[--p];
                prev[p] = (m >= _w_size ? m - _w_size : 0);
            } while (--n);

            more += _w_size;
        }

        if (!s._avail_in) {
            break;
        }

        n = read_buf(s, s._window, s._strstart + s._lookahead, more);
        s._lookahead += n;

        if (s._lookahead + s._insert >= MIN_MATCH) {
            str = s._strstart - s._insert;
            s._ins_h = s._window[str];

            s._ins_h = ((s._ins_h << s._hash_shift) ^ s._window[str + 1]) & s_hash_mask;

            while (s._insert) {
                s._ins_h = ((s._ins_h << s._hash_shift) ^ s._window[str + MIN_MATCH - 1]) & s_hash_mask;

                prev[str & s_w_mask] = head[s._ins_h];
                head[s._ins_h] = str;
                str++;
                s._insert--;
                
                if (s._lookahead + s._insert < MIN_MATCH) {
                    break;
                }
            }
        }
    } while (s._lookahead < MIN_LOOKAHEAD && s._avail_in);
}


function deflate_fast(s)
{
    var hash_head;
    var bflush;

    var head = s._head;
    var prev = s._prev;

    for (;;) {
        if (s._lookahead < MIN_LOOKAHEAD) {
            fill_window(s);
            if (!s._lookahead) {
                break;
            }
        }

        hash_head = 0;

        if (s._lookahead >= MIN_MATCH) {
            s._ins_h = ((s._ins_h << s._hash_shift) ^ s._window[s._strstart + MIN_MATCH - 1]) & s_hash_mask;
            hash_head = prev[s._strstart & s_w_mask] = head[s._ins_h];
            head[s._ins_h] = s._strstart;
        }

        if (hash_head && ((s._strstart - hash_head) <= (s_w_size - MIN_LOOKAHEAD))) {
            s._match_length = longest_match(s, hash_head);
        }
    
        if (s._match_length >= MIN_MATCH) {
            bflush = _tr_tally(s, s._strstart - s._match_start, s._match_length - MIN_MATCH);

            s._lookahead -= s._match_length;

            if (s._match_length <= 6 && s._lookahead >= MIN_MATCH) {
                s._match_length--;

                do {
                    s._strstart++;

                    s._ins_h = ((s._ins_h << s._hash_shift) ^ s._window[s._strstart + MIN_MATCH - 1]) & s_hash_mask;
                    hash_head = prev[s._strstart & s_w_mask] = head[s._ins_h];
                    head[s._ins_h] = s._strstart;
                } while (--s._match_length);

                s._strstart++;
            } else {
                s._strstart += s._match_length;
                s._match_length = 0;
                s._ins_h = s._window[s._strstart];
                s._ins_h = ((s._ins_h << s._hash_shift) ^ s._window[s._strstart + 1]) & s_hash_mask;
            }

        } else {
            bflush = _tr_tally(s, 0, s._window[s._strstart]);

            s._lookahead--;
            s._strstart++;
        }

        if (bflush) {
            flush_block_only(s, false);
            
            if (!s._avail_out) {
                return BS_NEED_MORE;
            }
        }
    }

    s._insert = ((s._strstart < (MIN_MATCH - 1)) ? s._strstart : MIN_MATCH - 1);

    flush_block_only(s, true);
    
    if (!s._avail_out) {
        return BS_FINISH_STARTED;
    }

    return BS_FINISH_DONE;
}


function deflateCurrentChunk(s)
{
    if (s._pending) {
        flush_pending(s);
        
        if (!s._avail_out) {
            return Z_OK;
        }
    }

    if (s._avail_in || s._lookahead || !s._finished) {
        var bstate = deflate_fast(s);

        if (bstate == BS_FINISH_STARTED || bstate == BS_FINISH_DONE) {
            s._finished = true;
        }
        
        if (bstate == BS_NEED_MORE || bstate == BS_FINISH_STARTED) {
            return Z_OK;
        }
        
        if (bstate == BS_BLOCK_DONE) {
            _tr_stored_block(s, 0, 0, false);
        }

        flush_pending(s);

        if (!s._avail_out) {
            return Z_OK;
        }
    }

    return Z_STREAM_END;
}


function adler32(buf)
{
    var s1 = 1, s2 = 0, MOD_ADLER = 65521;
    var mask = 255;

    var n, pos = 0, len = buf.length;

    while (len) {
        n = len > 2000 ? 2000 : len;
        len -= n;

        do {
            s1 += buf[pos++];
            s2 += s1;
        } while (--n);

        s1 %= MOD_ADLER;
        s2 %= MOD_ADLER;
    }

    return [
        (s2 >>> 8) & mask,
        s2 & mask,
        (s1 >>> 8) & mask,
        s1 & mask
    ];
}


function deflate(data)
{
    var i, len, a = 0, chunks = [], status, result;

    if (!static_init_done) {
        tr_static_init();
        static_init_done = true;
    }

    var s = {
        _input: null,
        _next_in: 0,
        _avail_in: 0,

        _output: null,
        _next_out: 0,
        _avail_out: 0,

        _finished: false,

        _pending_buf: new Uint8Array(s_lit_bufsize * 4),
        _pending_out: 0,
        _pending: 0,

        _window: new Uint8Array(s_w_size * 2),

        _prev: new Uint16Array(s_w_size),
        _head: new Uint16Array(s_hash_size),

        _ins_h: 0,

        _hash_shift: 5,
        _block_start: 0,

        _match_length: MIN_MATCH - 1,
        _strstart: 0,
        _match_start: 0,
        _lookahead: 0,

        _dyn_ltree: new Uint16Array(HEAP_SIZE * 2),
        _dyn_dtree: new Uint16Array((2 * D_CODES + 1) * 2),
        _bl_tree:   new Uint16Array((2 * BL_CODES + 1) * 2),

        _l_desc:  null,
        _d_desc:  null,
        _bl_desc: null,

        _bl_count: new Uint16Array(MAX_BITS + 1),
        _heap: new Uint16Array(2 * L_CODES + 1),

        _heap_len: 0,
        _heap_max: 0,

        _depth: new Uint16Array(2 * L_CODES + 1),

        _last_lit: 0,
        _opt_len: 0,
        _static_len: 0,
        _insert: 0,
        _bi_buf: 0,
        _bi_valid: 0
    }

    s._l_desc  = makeTreeDesc(s._dyn_ltree, static_l_desc);
    s._d_desc  = makeTreeDesc(s._dyn_dtree, static_d_desc);
    s._bl_desc = makeTreeDesc(s._bl_tree, static_bl_desc);

    init_block(s);

    s._input = data;
    s._next_in = 0;
    s._avail_in = s._input.length;


    // Call deflateCurrentChunk() on each chunk
    {
        do {
            if (!s._avail_out) {
                s._avail_out = 16384;
                s._output = new Uint8Array(s._avail_out);
                s._next_out = 0;
            }

            status = deflateCurrentChunk(s);

            if (!s._avail_out || !s._avail_in) {
                chunks.push(s._output.subarray(0, s._next_out));
            }
        } while ((s._avail_in > 0 || !s._avail_out) && status !== Z_STREAM_END);
    }

    // Combine chunks with 2 byte header (0x78 0x5e) and 4 byte footer (adler32)
    {
        a = 0;

        for (i = 0, len = chunks.length; i < len; i++) {
            a += chunks[i].length;
        }

        result = new Uint8Array(a + 6);
        a = 2;

        for (i = 0, len = chunks.length; i < len; i++) {
            var chunk = chunks[i];
            result.set(chunk, a);
            a += chunk.length;
        }
    }

    result.set([ 0x78, 0x5e ], 0);
    result.set(adler32(data), result.length - 4);

    return result;
}


exports.deflate = deflate;
