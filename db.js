/* db.js — where the till keeps its data on the iPad.
   Every screen built later talks to the data through this one file.
   Step 6a added stock deliveries, 6b expiry warnings (no change to the tables).

   Money is always whole kip, stored as a plain number. Never decimals.
   Dates are stored as text, YYYY-MM-DD, so they sort correctly. */

(function (global) {
  'use strict';

  var DB_NAME = 'till';
  var DB_VERSION = 2;   /* 2 added the settings table. Existing data is kept. */

  /* ---------- opening the database ---------- */

  var opening = null;

  function open() {
    if (opening) { return opening; }

    opening = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = function (event) {
        var db = event.target.result;

        /* Products — one row per thing you sell. */
        if (!db.objectStoreNames.contains('products')) {
          var products = db.createObjectStore('products', { keyPath: 'id' });
          products.createIndex('barcode', 'barcode', { unique: false });
          products.createIndex('name', 'name', { unique: false });
        }

        /* Batches — the actual stock. Quantity lives here, not on the
           product, because two deliveries of the same formula can have
           different expiry dates and different costs. */
        if (!db.objectStoreNames.contains('batches')) {
          var batches = db.createObjectStore('batches', { keyPath: 'id' });
          batches.createIndex('productId', 'productId', { unique: false });
          batches.createIndex('expiry', 'expiry', { unique: false });
          batches.createIndex('productExpiry', ['productId', 'expiry'], { unique: false });
        }

        /* Sales — one row per completed sale. Never edited, never deleted.
           A void or a refund is a new row pointing back at this one. */
        if (!db.objectStoreNames.contains('sales')) {
          var sales = db.createObjectStore('sales', { keyPath: 'id' });
          sales.createIndex('at', 'at', { unique: false });
        }

        /* Sale lines — the items inside a sale. One sale, many lines. */
        if (!db.objectStoreNames.contains('saleLines')) {
          var lines = db.createObjectStore('saleLines', { keyPath: 'id' });
          lines.createIndex('saleId', 'saleId', { unique: false });
        }

        /* Settings — small facts about the shop, like its name on receipts.
           One row per setting. Added in version 2. */
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = function () {
        var db = request.result;

        /* If a newer version of the till opens somewhere else, step aside
           rather than blocking it. Without this, a forgotten Safari tab can
           stop the app updating and the reason is invisible. */
        db.onversionchange = function () {
          db.close();
          opening = null;
        };

        resolve(db);
      };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('Close the till everywhere else, then try again')); };
    });

    return opening;
  }

  /* ---------- small helpers ---------- */

  function newId(prefix) {
    return prefix + '_' +
      Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 8);
  }

  function formatKip(amount) {
    return Math.round(amount).toLocaleString('en-US') + ' \u20AD';
  }

  function today() {
    return new Date().toISOString().slice(0, 10);
  }

  /* ---------- reading and writing ---------- */

  function put(storeName, record) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, 'readwrite');
        t.objectStore(storeName).put(record);
        t.oncomplete = function () { resolve(record); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function putMany(storeName, records) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, 'readwrite');
        var store = t.objectStore(storeName);
        records.forEach(function (r) { store.put(r); });
        t.oncomplete = function () { resolve(records); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  function getAll(storeName) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, 'readonly');
        var request = t.objectStore(storeName).getAll();
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  function count(storeName) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, 'readonly');
        var request = t.objectStore(storeName).count();
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  function byIndex(storeName, indexName, value) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, 'readonly');
        var request = t.objectStore(storeName).index(indexName).getAll(value);
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  function get(storeName, id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(storeName, 'readonly');
        var request = t.objectStore(storeName).get(id);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error); };
      });
    });
  }

  function counts() {
    return Promise.all([
      count('products'), count('batches'), count('sales'), count('saleLines')
    ]).then(function (n) {
      return { products: n[0], batches: n[1], sales: n[2], saleLines: n[3] };
    });
  }

  /* Batches of one product, earliest expiry first, empty ones dropped.
     This ordering is what first-expired-first-out is built on. */
  function batchesForProduct(productId) {
    return byIndex('batches', 'productId', productId).then(function (rows) {
      return rows
        .filter(function (b) { return b.qtyRemaining > 0; })
        .sort(function (a, b) {
          var ax = a.expiry || '9999-12-31';
          var bx = b.expiry || '9999-12-31';
          if (ax < bx) { return -1; }
          if (ax > bx) { return 1; }
          return a.receivedAt < b.receivedAt ? -1 : 1;
        });
    });
  }

  /* Empties every table. Deliberately does NOT delete the database itself:
     a browser refuses to delete a database that is still open anywhere,
     including in another tab, and then nothing happens and no error is
     reported. Emptying the tables always works. */
  function wipe() {
    var names = ['products', 'batches', 'sales', 'saleLines'];

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(names, 'readwrite');
        names.forEach(function (name) { t.objectStore(name).clear(); });
        t.oncomplete = function () { resolve(true); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Clearing was cancelled')); };
      });
    });
  }

  /* ---------- products ---------- */

  /* Keeps only the digits. "185,000" and "185 000 kip" both become 185000,
     so it does not matter how the price gets typed. */
  function toKip(text) {
    var digits = String(text === null || text === undefined ? '' : text)
      .replace(/[^0-9]/g, '');
    return digits === '' ? null : parseInt(digits, 10);
  }

  /* Selling prices land on the nearest 500 kip, because there is no coin
     smaller than that in daily use. Cost prices are left exactly as paid. */
  function roundPriceKip(amount) {
    var rounded = Math.round(amount / 500) * 500;
    return rounded < 500 ? 500 : rounded;
  }

  /* Every product in the catalog, by name. Hidden ones are left out. */
  function listProducts() {
    return getAll('products').then(function (rows) {
      return rows
        .filter(function (p) { return p.active !== false; })
        .sort(function (a, b) {
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
    });
  }

  /* Saves one product. No id means a new product, an id means an edit.
     Everything is checked here so no screen can write a bad record. */
  function saveProduct(input) {
    var name = String(input.name || '').trim().replace(/\s+/g, ' ');
    var barcode = String(input.barcode || '').replace(/\s+/g, '');
    var priceKip = toKip(input.priceKip);
    var costKip = toKip(input.costKip);

    if (!name) {
      return Promise.reject(new Error('Give the product a name.'));
    }
    if (priceKip === null || priceKip <= 0) {
      return Promise.reject(new Error('Give the product a selling price.'));
    }
    if (costKip === null) { costKip = 0; }

    priceKip = roundPriceKip(priceKip);

    var check = barcode
      ? byIndex('products', 'barcode', barcode)
      : Promise.resolve([]);

    return check.then(function (found) {
      var clash = found.filter(function (p) {
        return p.active !== false && p.id !== input.id;
      });
      if (clash.length) {
        return Promise.reject(
          new Error('That barcode is already on "' + clash[0].name + '".')
        );
      }

      if (!input.id) {
        return put('products', {
          id: newId('prod'),
          barcode: barcode,
          name: name,
          costKip: costKip,
          priceKip: priceKip,
          tracksExpiry: !!input.tracksExpiry,
          active: true,
          createdAt: new Date().toISOString()
        });
      }

      return get('products', input.id).then(function (existing) {
        if (!existing) {
          return Promise.reject(new Error('That product is no longer saved.'));
        }
        existing.barcode = barcode;
        existing.name = name;
        existing.costKip = costKip;
        existing.priceKip = priceKip;
        existing.tracksExpiry = !!input.tracksExpiry;
        existing.updatedAt = new Date().toISOString();
        return put('products', existing);
      });
    });
  }

  /* ---------- removing the old test data ----------
     Early versions had a "Save a test sale" button. It made a product called
     "Test formula 800g" (barcode 8850000000001), two batches and test sales.
     This finds exactly those records and nothing else, so it stays safe
     even after real sales exist. */

  function isSelfTestProduct(p) {
    return !!p && p.name === 'Test formula 800g' && p.barcode === '8850000000001';
  }

  function findSelfTestData() {
    return Promise.all([
      getAll('products'), getAll('batches'), getAll('sales'), getAll('saleLines')
    ]).then(function (all) {
      var productIds = {};
      all[0].forEach(function (p) { if (isSelfTestProduct(p)) { productIds[p.id] = true; } });

      var batchIds = all[1]
        .filter(function (b) { return productIds[b.productId]; })
        .map(function (b) { return b.id; });

      var linesBySale = {};
      all[3].forEach(function (l) {
        (linesBySale[l.saleId] = linesBySale[l.saleId] || []).push(l);
      });

      /* A sale is removed only if every one of its lines is test stock. */
      var saleIds = all[2]
        .filter(function (sale) {
          var lines = linesBySale[sale.id] || [];
          return lines.length > 0 && lines.every(function (l) { return productIds[l.productId]; });
        })
        .map(function (sale) { return sale.id; });

      /* Lines go only with their whole sale, or if their sale is already gone.
         A sale is never left half deleted. */
      var removedSale = {};
      saleIds.forEach(function (id) { removedSale[id] = true; });
      var saleExists = {};
      all[2].forEach(function (sale) { saleExists[sale.id] = true; });
      var testLineIds = all[3]
        .filter(function (l) {
          return productIds[l.productId] && (removedSale[l.saleId] || !saleExists[l.saleId]);
        })
        .map(function (l) { return l.id; });

      return {
        productIds: Object.keys(productIds),
        batchIds: batchIds,
        saleIds: saleIds,
        lineIds: testLineIds,
        total: Object.keys(productIds).length + batchIds.length + saleIds.length + testLineIds.length
      };
    });
  }

  function removeSelfTestData() {
    return findSelfTestData().then(function (found) {
      if (found.total === 0) { return found; }
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var names = ['products', 'batches', 'sales', 'saleLines'];
          var t = db.transaction(names, 'readwrite');
          found.productIds.forEach(function (id) { t.objectStore('products').delete(id); });
          found.batchIds.forEach(function (id) { t.objectStore('batches').delete(id); });
          found.saleIds.forEach(function (id) { t.objectStore('sales').delete(id); });
          found.lineIds.forEach(function (id) { t.objectStore('saleLines').delete(id); });
          t.oncomplete = function () { resolve(found); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('Removing was cancelled')); };
        });
      }).then(function (removed) {
        /* Prove it: look again, and complain if anything is left. */
        return findSelfTestData().then(function (left) {
          if (left.total !== 0) {
            return Promise.reject(new Error('Some test data is still there. Close the app and try again.'));
          }
          return removed;
        });
      });
    });
  }

  /* ---------- sales ---------- */

  var MAX_LINE_QTY = 999;
  var MAX_REFERENCE = 40;

  /* Today's date on the iPad's own clock, YYYY-MM-DD.
     (toISOString would give the date in London time, which is a day behind
     Laos between midnight and 7 in the morning.) */
  function localDate(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function isPositiveKip(n) {
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  }

  /* Checks the cart and payment and builds the records to save.
     Throws a plain-language error if anything is wrong. Saves nothing. */
  function buildSale(saleId, cart, payment, now) {
    if (typeof saleId !== 'string' || !/^sale_[a-z0-9_]+$/.test(saleId)) {
      throw new Error('This sale has no proper number. Go back and press Pay again.');
    }
    var lines = (cart && cart.lines) || [];
    if (!lines.length) {
      throw new Error('The cart is empty.');
    }

    var total = 0;
    var itemCount = 0;
    var seen = {};
    var saleLines = lines.map(function (l, i) {
      if (!l || typeof l.productId !== 'string' || !l.productId) {
        throw new Error('Item ' + (i + 1) + ' in the cart is not a proper product.');
      }
      if (seen[l.productId]) {
        throw new Error('"' + l.name + '" is in the cart twice.');
      }
      seen[l.productId] = true;
      if (!isPositiveKip(l.unitPriceKip)) {
        throw new Error('"' + l.name + '" has no proper price.');
      }
      if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_LINE_QTY) {
        throw new Error('"' + l.name + '" has a wrong quantity.');
      }
      var lineTotal = l.unitPriceKip * l.qty;
      total += lineTotal;
      itemCount += l.qty;
      return {
        id: saleId + '_L' + (i + 1),
        saleId: saleId,
        lineNo: i + 1,
        productId: l.productId,
        name: String(l.name || ''),
        barcode: String(l.barcode || ''),
        unitPriceKip: l.unitPriceKip,
        qty: l.qty,
        lineTotalKip: lineTotal
      };
    });

    if (!Number.isSafeInteger(total) || total <= 0) {
      throw new Error('The total is not right. Clear the cart and start again.');
    }

    var method = payment && payment.method;
    var receivedKip, changeKip, reference = '';

    if (method === 'cash') {
      receivedKip = payment.receivedKip;
      if (!Number.isSafeInteger(receivedKip) || receivedKip <= 0) {
        throw new Error('Enter the cash received.');
      }
      if (receivedKip < total) {
        throw new Error('Cash received is ' + formatKip(total - receivedKip) + ' short.');
      }
      changeKip = receivedKip - total;
    } else if (method === 'qr') {
      receivedKip = total;
      changeKip = 0;
      reference = String(payment.reference || '').trim().replace(/\s+/g, ' ');
      if (reference.length > MAX_REFERENCE) {
        throw new Error('The QR reference is too long (' + MAX_REFERENCE + ' characters at most).');
      }
    } else {
      throw new Error('Choose Cash or QR.');
    }

    var sale = {
      id: saleId,
      type: 'sale',
      at: now.toISOString(),
      date: localDate(now),
      totalKip: total,
      itemCount: itemCount,
      lineCount: saleLines.length,
      method: method,
      receivedKip: receivedKip,
      changeKip: changeKip,
      reference: reference
    };

    return { sale: sale, lines: saleLines };
  }

  /* A fresh id for a sale. The Pay screen asks for one when it opens and
     keeps it, so pressing Complete twice can only ever save one sale. */
  function newSaleId() {
    return newId('sale');
  }

  /* Saves a completed sale and its lines together, all or nothing.
     - Never changes or overwrites an existing sale.
     - If a sale with this id is already saved (a double tap, or a retry),
       it returns that saved sale instead of saving a second one.
     - Gives each sale the next receipt number: 1, 2, 3 ...
     - Does not touch stock yet. That arrives with Step 6.
     Resolves to { sale, lines, alreadySaved }. */
  function saveSale(saleId, cart, payment) {
    var built;
    try {
      built = buildSale(saleId, cart, payment, new Date());
    } catch (err) {
      return Promise.reject(err);
    }

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(['sales', 'saleLines'], 'readwrite');
        var sales = t.objectStore('sales');
        var linesStore = t.objectStore('saleLines');
        var result = null;

        sales.get(saleId).onsuccess = function (e) {
          var existing = e.target.result;
          if (existing) {
            linesStore.index('saleId').getAll(saleId).onsuccess = function (e2) {
              var saved = e2.target.result.sort(function (a, b) { return a.lineNo - b.lineNo; });
              result = { sale: existing, lines: saved, alreadySaved: true };
            };
            return;
          }

          /* Next receipt number = highest so far + 1. Worked out inside
             this same save, so two saves can never get the same number. */
          sales.getAll().onsuccess = function (e3) {
            var highest = 0;
            e3.target.result.forEach(function (s) {
              if (Number.isInteger(s.number) && s.number > highest) { highest = s.number; }
            });
            built.sale.number = highest + 1;

            /* add, not put: add refuses to overwrite anything. */
            sales.add(built.sale);
            built.lines.forEach(function (l) { linesStore.add(l); });
            result = { sale: built.sale, lines: built.lines, alreadySaved: false };
          };
        };

        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(new Error('The sale was NOT saved. Try Complete again.')); };
        t.onabort = function () { reject(new Error('The sale was NOT saved. Try Complete again.')); };
      });
    });
  }

  /* One saved sale with its lines, or null. */
  function getSale(saleId) {
    return Promise.all([get('sales', saleId), byIndex('saleLines', 'saleId', saleId)])
      .then(function (r) {
        if (!r[0]) { return null; }
        return { sale: r[0], lines: r[1].sort(function (a, b) { return a.lineNo - b.lineNo; }) };
      });
  }


  /* ---------- stock deliveries ----------
     A batch is one delivery of one product, with its own expiry date.
     A delivery is saved once and its details are never changed. Only the
     quantity left goes down later, when things are sold (Step 6c). */

  var MAX_DELIVERY_QTY = 99999;
  var MAX_LOT = 30;
  var MAX_EXPIRY_YEARS = 10;

  /* A fresh id for a delivery. The form asks for one when it opens, so
     pressing Save twice can only ever save one delivery. */
  function newBatchId() {
    return newId('batch');
  }

  /* True for a real calendar date written YYYY-MM-DD (so not 31/02). */
  function isRealDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) { return false; }
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) &&
      d.getMonth() === Number(m[2]) - 1 &&
      d.getDate() === Number(m[3]);
  }

  /* Checks a delivery and builds the record to save. Throws a
     plain-language error if anything is wrong. Saves nothing. */
  function buildDelivery(batchId, product, input, now) {
    if (typeof batchId !== 'string' || !/^batch_[a-z0-9_]+$/.test(batchId)) {
      throw new Error('This delivery has no proper number. Go back and open it again.');
    }
    if (!product || product.active === false) {
      throw new Error('That product is no longer saved.');
    }

    var qtyText = String(input.qty === null || input.qty === undefined ? '' : input.qty).trim();
    if (!/^[0-9,\s]+$/.test(qtyText)) {
      throw new Error('Type how many arrived, as a whole number.');
    }
    var qty = toKip(qtyText);
    if (qty === null || qty < 1) {
      throw new Error('Type how many arrived.');
    }
    if (qty > MAX_DELIVERY_QTY) {
      throw new Error('That quantity is too large to be right (' +
        MAX_DELIVERY_QTY.toLocaleString('en-US') + ' at most).');
    }

    var expiry = '';
    if (product.tracksExpiry) {
      expiry = String(input.expiry || '').trim();
      if (!expiry) {
        throw new Error('"' + product.name + '" has expiry dates. Enter the expiry date printed on it.');
      }
      if (!isRealDate(expiry)) {
        throw new Error('That expiry date is not a real date.');
      }
      var todayText = localDate(now);
      if (expiry < todayText) {
        throw new Error('That expiry date has already passed. Check the date on the product.');
      }
      var limit = localDate(new Date(now.getFullYear() + MAX_EXPIRY_YEARS, now.getMonth(), now.getDate()));
      if (expiry > limit) {
        throw new Error('That expiry date is more than ' + MAX_EXPIRY_YEARS + ' years away. Check the year.');
      }
    }

    var lot = tidy(input.lot);
    if (lot.length > MAX_LOT) {
      throw new Error('The lot number is too long (' + MAX_LOT + ' characters at most).');
    }

    var costKip = toKip(input.costKip);
    if (costKip !== null && costKip > 100000000) {
      throw new Error('That cost is too large to be right.');
    }

    return {
      id: batchId,
      productId: product.id,
      qtyReceived: qty,
      qtyRemaining: qty,
      expiry: expiry,          /* '' means this product has no expiry date */
      lot: lot,
      costKip: costKip,        /* null means not known */
      receivedAt: now.toISOString(),
      receivedDate: localDate(now)
    };
  }

  /* Saves one delivery, all or nothing, then reads it back to prove it.
     If this delivery id is already saved (a double tap), returns that one
     instead of saving a second. Resolves to { batch, alreadySaved }. */
  function addDelivery(batchId, input) {
    return get('products', input && input.productId).then(function (product) {
      var built;
      try {
        built = buildDelivery(batchId, product, input || {}, new Date());
      } catch (err) {
        return Promise.reject(err);
      }

      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction('batches', 'readwrite');
          var store = t.objectStore('batches');
          var result = null;

          store.get(batchId).onsuccess = function (e) {
            if (e.target.result) {
              result = { batch: e.target.result, alreadySaved: true };
              return;
            }
            /* add, not put: add refuses to overwrite anything. */
            store.add(built);
            result = { batch: built, alreadySaved: false };
          };

          t.oncomplete = function () { resolve(result); };
          t.onerror = function () { reject(new Error('The delivery was NOT saved. Try Save again.')); };
          t.onabort = function () { reject(new Error('The delivery was NOT saved. Try Save again.')); };
        });
      });
    }).then(function (result) {
      return get('batches', batchId).then(function (saved) {
        if (!saved || saved.qtyReceived !== result.batch.qtyReceived) {
          return Promise.reject(new Error('The delivery did not save. Try again.'));
        }
        return { batch: saved, alreadySaved: result.alreadySaved };
      });
    });
  }

  /* How many of each product are in stock: { productId: quantity }.
     Adds up what is left in every batch. */
  function stockByProduct() {
    return getAll('batches').then(function (rows) {
      var totals = {};
      rows.forEach(function (b) {
        if (Number.isInteger(b.qtyRemaining) && b.qtyRemaining > 0) {
          totals[b.productId] = (totals[b.productId] || 0) + b.qtyRemaining;
        }
      });
      return totals;
    });
  }


  /* ---------- expiry warnings ---------- */

  var SOON_DAYS = 60;

  /* Whole days from one YYYY-MM-DD date to another. */
  function daysBetween(fromYmd, toYmd) {
    var a = fromYmd.split('-').map(Number);
    var b = toYmd.split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }

  /* What one batch's expiry means today:
     'expired' (the date has passed), 'soon' (today up to SOON_DAYS away),
     or 'ok'. A batch expiring today is 'soon' — its last day to sell.
     Batches with no expiry date are always 'ok'. */
  function expiryState(expiry, todayYmd) {
    if (!expiry || !isRealDate(expiry)) { return { state: 'ok', days: null }; }
    var days = daysBetween(todayYmd, expiry);
    if (days < 0) { return { state: 'expired', days: days }; }
    if (days <= SOON_DAYS) { return { state: 'soon', days: days }; }
    return { state: 'ok', days: days };
  }

  /* From lists it is given (reads nothing): every batch still in stock
     that is expired or expiring soon, earliest expiry first. */
  function classifyExpiry(products, batches, todayYmd) {
    var byId = {};
    (products || []).forEach(function (p) {
      if (p && p.active !== false) { byId[p.id] = p; }
    });
    var list = [];
    (batches || []).forEach(function (b) {
      if (!b || !Number.isInteger(b.qtyRemaining) || b.qtyRemaining <= 0) { return; }
      var product = byId[b.productId];
      if (!product) { return; }
      var e = expiryState(b.expiry, todayYmd);
      if (e.state === 'ok') { return; }
      list.push({
        batchId: b.id,
        productId: b.productId,
        name: String(product.name || ''),
        expiry: b.expiry,
        lot: b.lot || '',
        qtyRemaining: b.qtyRemaining,
        state: e.state,
        days: e.days
      });
    });
    list.sort(function (x, y) {
      if (x.expiry !== y.expiry) { return x.expiry < y.expiry ? -1 : 1; }
      return x.name.localeCompare(y.name);
    });
    return list;
  }

  /* The warnings for right now, on this device's own clock. */
  function expiryAlerts() {
    return Promise.all([getAll('products'), getAll('batches')]).then(function (all) {
      return classifyExpiry(all[0], all[1], localDate(new Date()));
    });
  }

  /* ---------- shop details (for receipts) ---------- */

  var SHOP_LIMITS = { name: 40, phone: 30, thanks: 60 };

  function tidy(text) {
    var s = String(text === null || text === undefined ? '' : text);
    if (s.normalize) { s = s.normalize('NFC'); }
    return s.trim().replace(/\s+/g, ' ');
  }

  /* The shop details, or empty ones if nothing was saved yet. */
  function getShop() {
    return get('settings', 'shop').then(function (row) {
      return {
        name: row ? String(row.name || '') : '',
        phone: row ? String(row.phone || '') : '',
        thanks: row ? String(row.thanks || '') : ''
      };
    });
  }

  /* Saves the shop details, then reads them back to prove they saved. */
  function saveShop(input) {
    var shop = {
      key: 'shop',
      name: tidy(input && input.name),
      phone: tidy(input && input.phone),
      thanks: tidy(input && input.thanks),
      updatedAt: new Date().toISOString()
    };
    if (!shop.name) {
      return Promise.reject(new Error('Type the shop name.'));
    }
    var labels = { name: 'Shop name', phone: 'Phone', thanks: 'Bottom line' };
    for (var k in SHOP_LIMITS) {
      if (shop[k].length > SHOP_LIMITS[k]) {
        return Promise.reject(new Error(labels[k] + ' is too long (' + SHOP_LIMITS[k] + ' characters at most).'));
      }
    }
    return put('settings', shop).then(getShop).then(function (saved) {
      if (saved.name !== shop.name || saved.phone !== shop.phone || saved.thanks !== shop.thanks) {
        return Promise.reject(new Error('The shop details did not save. Try again.'));
      }
      return saved;
    });
  }

  global.Till = {
    SHOP_LIMITS: SHOP_LIMITS,
    getShop: getShop,
    saveShop: saveShop,
    open: open,
    put: put,
    putMany: putMany,
    getAll: getAll,
    get: get,
    byIndex: byIndex,
    count: count,
    counts: counts,
    batchesForProduct: batchesForProduct,
    listProducts: listProducts,
    saveProduct: saveProduct,
    roundPriceKip: roundPriceKip,
    toKip: toKip,
    wipe: wipe,
    newId: newId,
    formatKip: formatKip,
    today: today,
    findSelfTestData: findSelfTestData,
    removeSelfTestData: removeSelfTestData,
    newSaleId: newSaleId,
    saveSale: saveSale,
    getSale: getSale,
    localDate: localDate,
    newBatchId: newBatchId,
    isRealDate: isRealDate,
    addDelivery: addDelivery,
    stockByProduct: stockByProduct,
    MAX_DELIVERY_QTY: MAX_DELIVERY_QTY,
    SOON_DAYS: SOON_DAYS,
    daysBetween: daysBetween,
    expiryState: expiryState,
    classifyExpiry: classifyExpiry,
    expiryAlerts: expiryAlerts
  };

}(typeof window !== 'undefined' ? window : globalThis));
