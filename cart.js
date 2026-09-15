/* cart.js — the thinking behind the sell screen.
   Nothing in here reads or saves data. It only works on lists it is given,
   which is what lets it be checked automatically.

   Step 1: finding products from what is typed.
   Step 2 will add the cart and the total. */

(function (global) {
  'use strict';

  var MAX_RESULTS = 30;

  /* Makes text comparable: same Unicode form, lower case, single spaces.
     The Unicode step matters for Lao, where the same word can be stored
     with its marks in a different order. */
  function plain(text) {
    var s = String(text === null || text === undefined ? '' : text);
    if (s.normalize) { s = s.normalize('NFC'); }
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /* Finds products matching what was typed.
     - An exact barcode match comes first.
     - Then names that start with the typed text.
     - Then everything else that matches, by name.
     A name matches if it contains every typed word, in any order,
     so "nan 800" finds "NAN Optipro 800g".
     A barcode matches if it contains the typed text. */
  function matchProducts(products, typed) {
    var q = plain(typed);
    if (!q) { return []; }

    var words = q.split(' ');
    var compact = q.replace(/ /g, '');
    var scored = [];

    (products || []).forEach(function (p) {
      if (!p || p.active === false) { return; }

      var name = plain(p.name);
      var barcode = String(p.barcode || '');
      var rank = null;

      if (barcode && barcode === compact) {
        rank = 0;
      } else if (name.indexOf(q) === 0) {
        rank = 1;
      } else if (words.every(function (w) { return name.indexOf(w) !== -1; })) {
        rank = 2;
      } else if (barcode && barcode.indexOf(compact) !== -1) {
        rank = 3;
      }

      if (rank !== null) { scored.push({ rank: rank, name: name, product: p }); }
    });

    scored.sort(function (a, b) {
      if (a.rank !== b.rank) { return a.rank - b.rank; }
      return a.name.localeCompare(b.name);
    });

    return scored.slice(0, MAX_RESULTS).map(function (s) { return s.product; });
  }

  global.Sell = {
    MAX_RESULTS: MAX_RESULTS,
    plain: plain,
    matchProducts: matchProducts
  };

}(typeof window !== 'undefined' ? window : globalThis));
