/* importer.js — reading a product list from a spreadsheet (Step 13).
   Like cart.js, receipt.js, report.js and backup.js, nothing in here reads
   or saves data. It is given the text of a CSV file and the products
   already in the till, and says row by row what would happen. That is
   what lets it be checked automatically.

   CSV = "comma-separated values": a spreadsheet saved as plain text, one
   row per line. Excel and Google Sheets can both save one.

   Columns (headings in the first row, any order, extra columns ignored):
     Name     required
     Price    required, whole kip, rounded to the nearest 500 like the form
     Barcode  optional
     Expiry   optional: "yes" ticks "has an expiry date", blank or "no" does not

   Step 13a: template and check (saves nothing).
   Step 13b: the import itself (in db.js). */

(function (global) {
  'use strict';

  var MAX_FILE_BYTES = 2 * 1024 * 1024;   /* thousands of products fit in far less */
  var MAX_ROWS = 3000;
  var MAX_NAME = 80;
  var MAX_BARCODE = 30;
  var MAX_PRICE_KIP = 100000000;

  var HEADINGS = ['Name', 'Price', 'Barcode', 'Expiry'];

  /* Heading words that are understood, after lower-casing and removing
     everything that is not a letter ("Price (kip)" → "pricekip"). */
  var ALIASES = {
    name: ['name', 'product', 'productname', 'item', 'ຊື່', 'ຊື່ສິນຄ້າ'],
    price: ['price', 'pricekip', 'sellingprice', 'sellingpricekip', 'saleprice', 'ລາຄາ'],
    barcode: ['barcode', 'ean', 'code', 'ບາໂຄດ'],
    expiry: ['expiry', 'hasexpiry', 'expirydate', 'expires', 'ວັນໝົດອາຍຸ']
  };

  var YES = ['yes', 'y', '1', 'x', 'true', '\u2713', '\u2714', 'ແມ່ນ', 'ມີ'];
  var NO = ['', 'no', 'n', '0', 'false', '-', 'ບໍ່', 'ບໍ່ມີ'];

  function headingKey(text) {
    var k = String(text || '').toLowerCase().replace(/[^a-z\u0E80-\u0EFF]/g, '');
    var found = '';
    Object.keys(ALIASES).forEach(function (col) {
      if (ALIASES[col].indexOf(k) !== -1) { found = col; }
    });
    return found;
  }

  /* Same tidying the product form does, so "Baby  wipes " = "Baby wipes". */
  function cleanName(text) { return String(text || '').trim().replace(/\s+/g, ' '); }
  function nameKey(text) { return cleanName(text).toLowerCase(); }
  function cleanBarcode(text) { return String(text || '').replace(/\s+/g, ''); }

  /* Same rule as Till.roundPriceKip: nearest 500, never below 500. */
  function roundPriceKip(amount) {
    var rounded = Math.round(amount / 500) * 500;
    return rounded < 500 ? 500 : rounded;
  }

  /* Which character separates the columns. Excel in some countries uses
     ";" instead of ",". Decided from the heading row, outside quotes. */
  function separatorOf(text) {
    var line = '';
    var quoted = false;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (ch === '"') { quoted = !quoted; }
      if (!quoted && (ch === '\n' || ch === '\r')) { break; }
      if (!quoted) { line += ch; }
    }
    var counts = { ',': 0, ';': 0, '\t': 0 };
    for (var j = 0; j < line.length; j += 1) {
      if (counts[line[j]] !== undefined) { counts[line[j]] += 1; }
    }
    var best = ',';
    [';', '\t'].forEach(function (s) { if (counts[s] > counts[best]) { best = s; } });
    return best;
  }

  /* Splits CSV text into rows of cells. Handles quoted cells (which may
     hold commas, quotes written twice, and line breaks). */
  function parse(text) {
    var sep = separatorOf(text);
    var rows = [];
    var row = [];
    var cell = '';
    var quoted = false;
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i += 1; continue;
        }
        cell += ch; i += 1; continue;
      }
      if (ch === '"' && cell.trim() === '') { cell = ''; quoted = true; i += 1; continue; }
      if (ch === sep) { row.push(cell); cell = ''; i += 1; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(cell); rows.push(row); row = []; cell = '';
        if (ch === '\r' && text[i + 1] === '\n') { i += 1; }
        i += 1; continue;
      }
      cell += ch; i += 1;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return { rows: rows, separator: sep, unclosedQuote: quoted };
  }

  /* A price cell → whole kip, or a reason it is not one.
     "185000", "185,000", "185 000", "185.000", "185000 kip" and
     "185000.00" are all 185,000. "12.50" is refused: kip has no decimals. */
  function readPrice(text) {
    var t = String(text || '').trim().replace(/kip|₭|lak/gi, '').trim();
    if (t === '') { return { problem: 'Price is empty.' }; }
    if (/e[+-]?\d/i.test(t)) { return { problem: 'Price "' + text + '" is not a plain number.' }; }
    var n = null;
    if (/^\d+$/.test(t)) {
      n = parseInt(t, 10);
    } else if (/^\d{1,3}([,. \u00A0]\d{3})+$/.test(t)) {
      n = parseInt(t.replace(/[^0-9]/g, ''), 10);
    } else if (/^\d{1,3}(,\d{3})*\.0+$/.test(t) || /^\d+\.0+$/.test(t)) {
      n = parseInt(t.split('.')[0].replace(/,/g, ''), 10);
    }
    if (n === null || !isFinite(n)) {
      return { problem: 'Price "' + String(text).trim() + '" is not a whole number of kip.' };
    }
    if (n <= 0) { return { problem: 'Price is zero.' }; }
    if (n > MAX_PRICE_KIP) {
      return { problem: 'Price ' + n.toLocaleString('en-US') + ' is too high. Check the number.' };
    }
    return { typedKip: n, priceKip: roundPriceKip(n) };
  }

  function readExpiry(text) {
    var t = String(text || '').trim().toLowerCase();
    if (YES.indexOf(t) !== -1) { return { tracksExpiry: true }; }
    if (NO.indexOf(t) !== -1) { return { tracksExpiry: false }; }
    return { problem: 'Expiry "' + String(text).trim() + '" should be yes or blank.' };
  }

  /* The whole check. `existing` = the products already in the till.
     Returns:
       problems  reasons the file as a whole cannot be read ([] if fine)
       notes     things worth knowing that are not problems
       rows      one per filled row: {rowNo, name, priceKip, typedKip,
                 barcode, tracksExpiry, state 'add'|'skip'|'bad', why}
       add, skip, bad   counts
       ok        true when there is at least one row to add and no file problem */
  function check(text, existing) {
    var out = { ok: false, problems: [], notes: [], rows: [], add: 0, skip: 0, bad: 0 };
    text = String(text || '');

    if (text.slice(0, 2) === 'PK') {
      out.problems.push('This is an Excel file, not a CSV file. In Excel choose File → Save As → "CSV UTF-8", then pick that file.');
      return out;
    }
    if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); }
    if (text.indexOf('\uFFFD') !== -1) {
      out.problems.push('Some letters could not be read (Lao names usually). Save the file again as "CSV UTF-8" and pick it again.');
      return out;
    }
    if (text.trim() === '') {
      out.problems.push('The file is empty.');
      return out;
    }

    var p = parse(text);
    if (p.unclosedQuote) {
      out.problems.push('A quote mark (") is opened but never closed, so the file cannot be read safely. Remove stray " marks from names.');
      return out;
    }

    /* The heading row. */
    var head = p.rows[0].map(headingKey);
    var col = {};
    var extra = [];
    head.forEach(function (k, i) {
      if (!k) {
        if (String(p.rows[0][i]).trim()) { extra.push(String(p.rows[0][i]).trim()); }
        return;
      }
      if (col[k] !== undefined) {
        out.problems.push('The heading "' + String(p.rows[0][i]).trim() + '" appears twice. Keep only one.');
        return;
      }
      col[k] = i;
    });
    if (col.name === undefined || col.price === undefined) {
      out.problems.push('The first row must hold the headings, including Name and Price. ' +
        'Found: ' + (p.rows[0].map(function (c) { return '"' + String(c).trim() + '"'; }).join(', ') || 'nothing') +
        '. The template has the right headings.');
    }
    if (out.problems.length) { return out; }
    if (extra.length) {
      out.notes.push('Columns left out (not used by the till): ' + extra.join(', ') + '.');
    }
    if (col.barcode === undefined) { out.notes.push('No Barcode column: products will have no barcode.'); }
    if (col.expiry === undefined) { out.notes.push('No Expiry column: no product gets the expiry tick.'); }

    var filled = [];
    for (var r = 1; r < p.rows.length; r += 1) {
      var cells = p.rows[r];
      if (cells.every(function (c) { return String(c).trim() === ''; })) { continue; }
      filled.push({ rowNo: r + 1, cells: cells });
    }
    if (!filled.length) {
      out.problems.push('There are headings but no products under them.');
      return out;
    }
    if (filled.length > MAX_ROWS) {
      out.problems.push('The file has ' + filled.length + ' products; ' + MAX_ROWS + ' at most at once. Split it into two files.');
      return out;
    }

    /* What the till already has. Hidden products do not block a barcode,
       the same as the product form. */
    var tillNames = {};
    var tillBarcodes = {};
    (existing || []).forEach(function (prod) {
      if (!prod) { return; }
      tillNames[nameKey(prod.name)] = prod.name;
      if (prod.active !== false && prod.barcode) { tillBarcodes[cleanBarcode(prod.barcode)] = prod.name; }
    });

    var fileNames = {};
    var fileBarcodes = {};

    filled.forEach(function (f) {
      function cell(k) { return col[k] === undefined ? '' : String(f.cells[col[k]] === undefined ? '' : f.cells[col[k]]); }
      var row = {
        rowNo: f.rowNo,
        name: cleanName(cell('name')),
        priceKip: null,
        typedKip: null,
        barcode: cleanBarcode(cell('barcode')),
        tracksExpiry: false,
        state: 'add',
        why: []
      };

      if (!row.name) { row.why.push('Name is empty.'); }
      else if (row.name.length > MAX_NAME) { row.why.push('Name is longer than ' + MAX_NAME + ' letters.'); }

      var price = readPrice(cell('price'));
      if (price.problem) { row.why.push(price.problem); }
      else { row.priceKip = price.priceKip; row.typedKip = price.typedKip; }

      var ex = readExpiry(cell('expiry'));
      if (ex.problem) { row.why.push(ex.problem); } else { row.tracksExpiry = ex.tracksExpiry; }

      var scientific = /^\d+([.,]\d+)?e\+?\d+$/i.test(row.barcode);
      if (scientific) {
        row.why.push('Barcode "' + row.barcode + '" was changed by the spreadsheet into a short number. ' +
          'Set the Barcode column to Text and type it again.');
      } else if (row.barcode.length > MAX_BARCODE) {
        row.why.push('Barcode is longer than ' + MAX_BARCODE + ' characters.');
      }

      if (row.why.length) { row.state = 'bad'; }

      /* Duplicates. A name already in the till is skipped (never changed).
         Anything doubled inside the file, or a barcode on another product,
         is a problem to fix in the spreadsheet. */
      var nk = nameKey(row.name);
      if (row.name && tillNames[nk] !== undefined) {
        if (row.state !== 'bad') {
          row.state = 'skip';
          row.why.push('Already in the till as "' + tillNames[nk] + '". Left unchanged.');
        }
      } else {
        if (row.name) {
          if (fileNames[nk]) {
            row.state = 'bad';
            row.why.push('Same name as row ' + fileNames[nk].rowNo + '.');
            if (fileNames[nk].state !== 'bad') {
              fileNames[nk].state = 'bad';
              fileNames[nk].why.push('Same name as row ' + row.rowNo + '.');
            }
          } else {
            fileNames[nk] = row;
          }
        }
        if (row.barcode && !scientific) {
          if (tillBarcodes[row.barcode] !== undefined) {
            row.state = 'bad';
            row.why.push('Barcode ' + row.barcode + ' is already on "' + tillBarcodes[row.barcode] + '".');
          } else if (fileBarcodes[row.barcode]) {
            var first = fileBarcodes[row.barcode];
            row.state = 'bad';
            row.why.push('Same barcode as row ' + first.rowNo + '.');
            first.state = 'bad';
            first.why.push('Same barcode as row ' + row.rowNo + '.');
          } else {
            fileBarcodes[row.barcode] = row;
          }
        }
      }
      out.rows.push(row);
    });

    out.rows.forEach(function (row) { out[row.state] += 1; });
    var rounded = out.rows.filter(function (row) {
      return row.state === 'add' && row.typedKip !== row.priceKip;
    }).length;
    if (rounded) {
      out.notes.push(rounded + (rounded === 1 ? ' price was' : ' prices were') +
        ' rounded to the nearest 500 kip, as the product form does.');
    }
    out.ok = out.add > 0;
    return out;
  }

  /* The blank template: headings only. The first character (a "BOM")
     tells Excel the file is UTF-8, so Lao letters open correctly. */
  function templateText() {
    return '\uFEFF' + HEADINGS.join(',') + '\r\n';
  }

  var TEMPLATE_NAME = 'till-products-template.csv';

  global.ProductImport = {
    check: check,
    parse: parse,
    readPrice: readPrice,
    readExpiry: readExpiry,
    headingKey: headingKey,
    templateText: templateText,
    TEMPLATE_NAME: TEMPLATE_NAME,
    HEADINGS: HEADINGS,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    MAX_ROWS: MAX_ROWS,
    MAX_NAME: MAX_NAME
  };
})(typeof window !== 'undefined' ? window : globalThis);
