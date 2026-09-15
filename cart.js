/* cart.js — the thinking behind the sell screen.
   Nothing in here reads or saves data. It only works on lists it is given,
   which is what lets it be checked automatically.

   Step 1: finding products from what is typed.
   Step 2: the cart and its total.
   Step 3: changing quantities and removing lines.
   Step 4: recognising a scanned barcode.

   A cart is { lines: [...] }. Each line is
   { productId, name, barcode, unitPriceKip, qty }.
   Functions here never change the cart they are given. They return a new
   one, so a failed step can never leave a cart half changed. */

(function (global) {
  'use strict';

  var MAX_RESULTS = 30;
  var MAX_QTY = 999;

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

  /* ---------- scanning ---------- */

  /* Lao digits (໐–໙) and Thai digits (๐–๙) become 0–9, and spaces go.
     Some keyboards send these instead of normal digits. */
  function cleanScan(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/[\u0ED0-\u0ED9]/g, function (c) { return String(c.charCodeAt(0) - 0x0ED0); })
      .replace(/[\u0E50-\u0E59]/g, function (c) { return String(c.charCodeAt(0) - 0x0E50); })
      .replace(/\s+/g, '');
  }

  /* True if the text has Lao letters in it. A scan that arrives like this
     means the device keyboard is set to Lao, not English. */
  function hasLaoLetters(text) {
    return /[\u0E80-\u0ECF\u0EDA-\u0EFF]/.test(String(text || ''));
  }

  /* The one product whose barcode is exactly what was scanned, or null.
     A 13-digit code starting with 0 and the same code without that 0
     count as the same barcode, because scanners differ on this. */
  function findByBarcode(products, typed) {
    var code = cleanScan(typed);
    if (!code) { return null; }
    var alt = null;
    if (/^0\d{12}$/.test(code)) { alt = code.slice(1); }
    if (/^\d{12}$/.test(code)) { alt = '0' + code; }

    var exact = null;
    var near = null;
    (products || []).forEach(function (p) {
      if (!p || p.active === false || !p.barcode) { return; }
      var b = String(p.barcode);
      if (b === code && !exact) { exact = p; }
      if (alt && b === alt && !near) { near = p; }
    });
    return exact || near;
  }

  /* ---------- the cart ---------- */

  function emptyCart() {
    return { lines: [] };
  }

  function isWholeKip(n) {
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  }

  function copyLines(cart) {
    return ((cart && cart.lines) || []).map(function (l) {
      return {
        productId: l.productId,
        name: l.name,
        barcode: l.barcode,
        unitPriceKip: l.unitPriceKip,
        qty: l.qty
      };
    });
  }

  /* Adds one of a product. If it is already in the cart, that line goes up
     by one and keeps the price it was added at. A new product goes to the
     top of the cart, so the latest item is always the one you see first. */
  function addToCart(cart, product) {
    if (!product || !product.id) {
      throw new Error('That product could not be added.');
    }
    if (!isWholeKip(product.priceKip)) {
      throw new Error('"' + (product.name || 'This product') +
        '" has no proper selling price. Fix it on the Products screen.');
    }

    var lines = copyLines(cart);
    var found = null;
    lines.forEach(function (l) { if (l.productId === product.id) { found = l; } });

    if (found) {
      if (found.qty >= MAX_QTY) {
        throw new Error('Cannot sell more than ' + MAX_QTY + ' of one product in a sale.');
      }
      found.qty += 1;
      /* Move it to the top so the change is visible. */
      lines = [found].concat(lines.filter(function (l) { return l !== found; }));
    } else {
      lines.unshift({
        productId: product.id,
        name: String(product.name || ''),
        barcode: String(product.barcode || ''),
        unitPriceKip: product.priceKip,
        qty: 1
      });
    }

    return { lines: lines };
  }

  /* Raises or lowers one line by `step` (+1 or -1). Stays between 1 and
     the limit: taking a line to zero is done with removeLine, on purpose,
     so a mistaken tap on minus never makes an item disappear.
     The line keeps its place in the cart. */
  function changeQty(cart, productId, step) {
    if (step !== 1 && step !== -1) {
      throw new Error('Quantity can only change by one at a time.');
    }
    var lines = copyLines(cart);
    var found = null;
    lines.forEach(function (l) { if (l.productId === productId) { found = l; } });
    if (!found) {
      throw new Error('That item is no longer in the cart.');
    }
    var next = found.qty + step;
    if (next < 1) { next = 1; }
    if (next > MAX_QTY) {
      throw new Error('Cannot sell more than ' + MAX_QTY + ' of one product in a sale.');
    }
    found.qty = next;
    return { lines: lines };
  }

  /* Takes one line out of the cart. Other lines keep their order. */
  function removeLine(cart, productId) {
    var lines = copyLines(cart);
    var kept = lines.filter(function (l) { return l.productId !== productId; });
    if (kept.length === lines.length) {
      throw new Error('That item is no longer in the cart.');
    }
    return { lines: kept };
  }

  function lineTotal(line) {
    return line.unitPriceKip * line.qty;
  }

  /* The total of the whole cart, in whole kip. */
  function cartTotal(cart) {
    var total = 0;
    ((cart && cart.lines) || []).forEach(function (l) { total += lineTotal(l); });
    if (!Number.isSafeInteger(total)) {
      throw new Error('The total is too large to be right.');
    }
    return total;
  }

  /* How many items, counting quantities: 2 tins + 1 pack = 3. */
  function cartCount(cart) {
    var n = 0;
    ((cart && cart.lines) || []).forEach(function (l) { n += l.qty; });
    return n;
  }

  global.Sell = {
    MAX_RESULTS: MAX_RESULTS,
    cleanScan: cleanScan,
    hasLaoLetters: hasLaoLetters,
    findByBarcode: findByBarcode,
    MAX_QTY: MAX_QTY,
    emptyCart: emptyCart,
    addToCart: addToCart,
    changeQty: changeQty,
    removeLine: removeLine,
    lineTotal: lineTotal,
    cartTotal: cartTotal,
    cartCount: cartCount,
    plain: plain,
    matchProducts: matchProducts
  };

}(typeof window !== 'undefined' ? window : globalThis));
