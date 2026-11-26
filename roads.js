/* ============================================================
   Baccarat road engine — Big Road + derived roads + predictor

   Rules implemented from the published specifications:
     - Interblock / WA Gaming "Baccarat Game Description" v2.3.1,
       chapters Main Road, Big Eye Road, Small Road, Cockroach Road
     - Wizard of Odds, "Baccarat Score Boards"
     - EdgeLV, "How to Read Baccarat Roads" (worked examples)

   Terminology
     logical column : one streak (one colour) in the Big Road, rows are
                      unbounded there; the 6-row grid is display only.
     depth          : number of hands in a logical column.
     k              : look-back distance — BEB 1, Small Road 2, Pig 3.

   Derived road rules, applied to every Banker/Player hand after the
   road has enough history (all comparing against columns already
   complete, so depths are final):
     new column (row 0)      : depth[c-1] === depth[c-1-k] -> RED else BLUE
     column continues (row r): depth[c-k] === r          -> BLUE else RED
                               (r equal to the reference depth means the
                                reference column ended on that row: the
                                pattern broke. Above or below it, the two
                                reference cells are both filled or both
                                empty, which counts as a repeat -> RED.)
     RED = the Big Road repeated its shape, BLUE = it did not.
     Ties never reach the derived roads.
   ============================================================ */

(function (root) {
  'use strict';

  var ROWS = 6;

  function key(r, c) { return r + ':' + c; }

  /* Place logical columns onto the 6-row display grid.
     A column runs down its own display column; overflow past row 6 is a
     dragon's tail that runs right along the bottom row. Space is reserved
     up front, so tails can never collide with a later column. */
  function place(columns, rows) {
    var pos = [];
    var startCol = [];
    var i;
    var lastRight = -1;

    for (i = 0; i < columns.length; i += 1) {
      var d;
      if (i === 0) {
        d = 0;
      } else {
        d = lastRight + 1;
      }
      startCol[i] = d;
      var len = columns[i].len;
      var arr = [];
      for (var n = 0; n < len; n += 1) {
        if (n < rows) arr.push({ r: n, c: d });
        else arr.push({ r: rows - 1, c: d + (n - rows + 1) });
      }
      pos.push(arr);
      lastRight = arr.length ? arr[arr.length - 1].c : d;
    }

    return { pos: pos, startCol: startCol, colCount: lastRight + 1 };
  }

  /* Big Road: one column per streak, ties as slashes on the previous cell. */
  function buildRoad(hands, options) {
    var rows = (options && options.rows) || ROWS;
    var columns = [];
    var events = [];
    var lastEvent = null;
    var i;

    for (i = 0; i < hands.length; i += 1) {
      var hand = hands[i];
      if (hand.o === 'T') {
        if (lastEvent) lastEvent.ties += 1;
        continue;
      }
      var prev = columns[columns.length - 1];
      if (prev && prev.side === hand.o) prev.len += 1;
      else columns.push({ side: hand.o, len: 1 });

      var c = columns.length - 1;
      var ev = { c: c, r: columns[c].len - 1, side: hand.o, ties: 0, hand: hand };
      events.push(ev);
      lastEvent = ev;
    }

    var laid = place(columns, rows);
    var cells = new Map();

    for (i = 0; i < events.length; i += 1) {
      var e = events[i];
      var p = laid.pos[e.c][e.r];
      e.dr = p.r;
      e.dc = p.c;
      cells.set(key(p.r, p.c), { side: e.side, ties: e.ties, hand: e.hand });
    }

    return {
      rows: rows,
      columns: columns,
      depths: columns.map(function (col) { return col.len; }),
      events: events,
      cells: cells,
      colCount: laid.colCount
    };
  }

  /* Derived road marks for look-back k, in hand order. */
  function derivedMarks(road, k) {
    var depths = road.depths;
    var marks = [];
    var i;

    for (i = 0; i < road.events.length; i += 1) {
      var ev = road.events[i];
      var mark = null;

      if (ev.r === 0) {
        var ref = ev.c - 1 - k;
        if (ref >= 0) mark = depths[ev.c - 1] === depths[ref] ? 'R' : 'B';
      } else {
        var ref2 = ev.c - k;
        if (ref2 >= 0) mark = depths[ref2] === ev.r ? 'B' : 'R';
      }

      if (mark) marks.push({ m: mark, ev: ev });
    }

    return marks;
  }

  /* Lay a flat list of marks out like a Big Road: same colour goes down,
     a colour change opens a new column. */
  function layoutMarks(marks, options) {
    var rows = (options && options.rows) || ROWS;
    var columns = [];
    var i;

    for (i = 0; i < marks.length; i += 1) {
      var prev = columns[columns.length - 1];
      if (prev && prev.m === marks[i].m) prev.len += 1;
      else columns.push({ m: marks[i].m, len: 1 });
    }

    var laid = place(columns, rows);
    var cells = new Map();
    var idx = 0;
    var ci;
    var n;

    for (ci = 0; ci < columns.length; ci += 1) {
      for (n = 0; n < columns[ci].len; n += 1) {
        var p = laid.pos[ci][n];
        cells.set(key(p.r, p.c), { m: marks[idx].m });
        idx += 1;
      }
    }

    return { cells: cells, colCount: laid.colCount, rows: rows };
  }

  /* What each derived road would print if the next hand were `side`. */
  function predictFor(road, k, side) {
    var depths = road.depths;
    var n = road.columns.length;
    if (!n) return null;
    var last = road.columns[n - 1];

    if (last.side === side) {
      var ref = n - 1 - k;
      if (ref < 0) return null;
      return depths[ref] === last.len ? 'B' : 'R';
    }

    var ref2 = n - 1 - k; // (n) - 1 - k for the would-be next column
    if (ref2 < 0) return null;
    return depths[n - 1] === depths[ref2] ? 'R' : 'B';
  }

  function predictor(road) {
    return {
      B: {
        beb: predictFor(road, 1, 'B'),
        small: predictFor(road, 2, 'B'),
        cock: predictFor(road, 3, 'B')
      },
      P: {
        beb: predictFor(road, 1, 'P'),
        small: predictFor(road, 2, 'P'),
        cock: predictFor(road, 3, 'P')
      }
    };
  }

  var api = {
    ROWS: ROWS,
    buildRoad: buildRoad,
    derivedMarks: derivedMarks,
    layoutMarks: layoutMarks,
    predictor: predictor
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Roads = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
