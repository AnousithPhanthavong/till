/* db.js — where the till keeps its data on the iPad.
   Every screen built later talks to the data through this one file.
   Step 6a added stock deliveries, 6b expiry warnings, 6c selling takes
   stock earliest-expiry first (no change to the tables). 6d added the
   removals table: stock taken out with a reason. 8a added reading
   everything at once for a backup (no change to the tables). 8c added
   loading a backup into an empty till. 8d remembers when the last backup
   was made (a settings row, no change to the tables). 9a keeps a copy of
   the cart in progress in the browser's localStorage (not a table, and not
   part of backups: it is not business data, only a sale not yet made).
   9d start fresh: clears test sales, deliveries and removals before
   opening, keeps products and shop details (a settings row, key 'fresh',
   locks it; no change to the tables).

   Money is always whole kip, stored as a plain number. Never decimals.
   Dates are stored as text, YYYY-MM-DD, so they sort correctly. */

(function (global) {
  'use strict';

  var DB_NAME = 'till';
  var DB_VERSION = 3;   /* 2 added settings, 3 added removals. Existing data is kept. */

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

        /* Removals — stock taken out of a delivery with a reason (damaged,
           expired, miscounted). Never edited, never deleted. Added in
           version 3. */
        if (!db.objectStoreNames.contains('removals')) {
          var removals = db.createObjectStore('removals', { keyPath: 'id' });
          removals.createIndex('batchId', 'batchId', { unique: false });
          removals.createIndex('productId', 'productId', { unique: false });
          removals.createIndex('at', 'at', { unique: false });
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
    var names = ['products', 'batches', 'sales', 'saleLines', 'removals'];

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
     - Takes the items out of stock, earliest expiry first, skipping
       expired batches, in the same save (Step 6c). Each line records
       which batches it came from (batches) and how many were sold
       beyond the stock on record (unrecordedQty). A sale is never
       refused for lack of recorded stock.
     - A sale saved twice (same id) never takes stock twice.
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
        var t = db.transaction(['sales', 'saleLines', 'batches'], 'readwrite');
        var sales = t.objectStore('sales');
        var linesStore = t.objectStore('saleLines');
        var batchStore = t.objectStore('batches');
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

            /* Read each product's batches, still inside this same save. */
            var waiting = built.lines.length;
            var batchesFor = {};
            built.lines.forEach(function (l) {
              batchStore.index('productId').getAll(l.productId).onsuccess = function (e4) {
                batchesFor[l.productId] = e4.target.result;
                waiting -= 1;
                if (waiting === 0) { finish(); }
              };
            });

            function finish() {
              /* Take stock earliest-expiry first and note where it came from.
                 Everything is checked before anything is written. */
              var changed = {};
              var ok = true;
              built.lines.forEach(function (l) {
                var plan = allocate(batchesFor[l.productId], l.qty, built.sale.date);
                l.batches = plan.takes;
                l.unrecordedQty = plan.unrecordedQty;
                plan.takes.forEach(function (take) {
                  var b = batchesFor[l.productId].filter(function (x) { return x.id === take.batchId; })[0];
                  if (!b || !Number.isInteger(take.qty) || take.qty < 1 || take.qty > b.qtyRemaining) {
                    ok = false;
                    return;
                  }
                  b.qtyRemaining -= take.qty;
                  changed[b.id] = b;
                });
              });
              if (!ok) {
                t.abort();
                return;
              }
              Object.keys(changed).forEach(function (id) { batchStore.put(changed[id]); });

              /* add, not put: add refuses to overwrite anything. */
              sales.add(built.sale);
              built.lines.forEach(function (l) { linesStore.add(l); });
              result = { sale: built.sale, lines: built.lines, alreadySaved: false };
            }
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


  /* ---------- removing stock (Step 6d) ----------
     Items taken out of one delivery with a reason. Each removal is its own
     new record. The delivery's qtyRemaining goes down in the same
     all-or-nothing save, so the two can never disagree. Nothing is ever
     quietly changed or deleted. */

  var REMOVAL_REASONS = {
    damaged: 'Damaged',
    expired: 'Expired',
    miscounted: 'Miscounted',
    other: 'Other'
  };
  var MAX_REMOVAL_NOTE = 60;

  /* A fresh id for a removal. The form asks for one when it opens, so
     pressing Save twice can only ever save one removal. */
  function newRemovalId() {
    return newId('rmv');
  }

  /* Checks the form (not the delivery) and builds most of the record.
     Throws a plain-language error if anything is wrong. Saves nothing. */
  function buildRemoval(removalId, input, now) {
    if (typeof removalId !== 'string' || !/^rmv_[a-z0-9_]+$/.test(removalId)) {
      throw new Error('This removal has no proper number. Go back and open it again.');
    }
    input = input || {};
    if (typeof input.batchId !== 'string' || !input.batchId) {
      throw new Error('Choose which delivery to remove from.');
    }

    var qtyText = String(input.qty === null || input.qty === undefined ? '' : input.qty).trim();
    if (!/^[0-9,\s]+$/.test(qtyText)) {
      throw new Error('Type how many to remove, as a whole number.');
    }
    var qty = toKip(qtyText);
    if (qty === null || qty < 1) {
      throw new Error('Type how many to remove.');
    }

    var reason = String(input.reason || '');
    if (!Object.prototype.hasOwnProperty.call(REMOVAL_REASONS, reason)) {
      throw new Error('Choose a reason.');
    }

    var note = tidy(input.note);
    if (note.length > MAX_REMOVAL_NOTE) {
      throw new Error('The note is too long (' + MAX_REMOVAL_NOTE + ' characters at most).');
    }
    if (reason === 'other' && !note) {
      throw new Error('For "Other", write a short note saying why.');
    }

    return {
      id: removalId,
      type: 'removal',
      batchId: input.batchId,
      qty: qty,
      reason: reason,
      note: note,
      at: now.toISOString(),
      date: localDate(now)
    };
  }

  /* Checks a removal against the delivery it comes from. Reads and changes
     nothing. Returns an error message, or '' if it is fine. */
  function removalProblem(batch, qty) {
    if (!batch) { return 'That delivery is no longer saved.'; }
    var left = Number.isInteger(batch.qtyRemaining) ? batch.qtyRemaining : 0;
    if (left <= 0) { return 'Nothing is left in that delivery.'; }
    if (qty > left) {
      return 'Only ' + left + ' left in that delivery. You cannot remove ' + qty + '.';
    }
    return '';
  }

  /* Takes items out of one delivery and saves the reason, all or nothing,
     then reads it back to prove it.
     - Never removes more than is left.
     - Same removal id twice (a double tap or retry) saves once and takes
       stock once; the saved one is returned.
     Resolves to { removal, alreadySaved }. */
  function removeStock(removalId, input) {
    var built;
    try {
      built = buildRemoval(removalId, input, new Date());
    } catch (err) {
      return Promise.reject(err);
    }

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(['removals', 'batches'], 'readwrite');
        var removals = t.objectStore('removals');
        var batches = t.objectStore('batches');
        var result = null;
        var problem = '';

        removals.get(removalId).onsuccess = function (e) {
          if (e.target.result) {
            result = { removal: e.target.result, alreadySaved: true };
            return;
          }
          batches.get(built.batchId).onsuccess = function (e2) {
            var batch = e2.target.result;
            problem = removalProblem(batch, built.qty);
            if (problem) {
              t.abort();
              return;
            }
            built.productId = batch.productId;
            built.expiry = batch.expiry || '';
            built.lot = batch.lot || '';
            built.qtyBefore = batch.qtyRemaining;
            built.qtyAfter = batch.qtyRemaining - built.qty;

            batch.qtyRemaining = built.qtyAfter;
            batches.put(batch);
            /* add, not put: add refuses to overwrite anything. */
            removals.add(built);
            result = { removal: built, alreadySaved: false };
          };
        };

        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(new Error(problem || 'The removal was NOT saved. Try Save again.')); };
        t.onabort = function () { reject(new Error(problem || 'The removal was NOT saved. Try Save again.')); };
      });
    }).then(function (result) {
      return get('removals', removalId).then(function (saved) {
        if (!saved || saved.qty !== result.removal.qty || saved.batchId !== result.removal.batchId) {
          return Promise.reject(new Error('The removal did not save. Try again.'));
        }
        return { removal: saved, alreadySaved: result.alreadySaved };
      });
    });
  }

  /* Every removal for one product, newest first. */
  function removalsForProduct(productId) {
    return byIndex('removals', 'productId', productId).then(function (rows) {
      return rows.sort(function (a, b) { return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0); });
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

  /* ---------- taking stock when selling (first-expired-first-out) ---------- */

  /* Earliest expiry first. No expiry date goes last. Same date: the
     delivery that arrived first goes first. */
  function fefoOrder(a, b) {
    var ax = a.expiry || '9999-12-31';
    var bx = b.expiry || '9999-12-31';
    if (ax !== bx) { return ax < bx ? -1 : 1; }
    if (a.receivedAt !== b.receivedAt) { return a.receivedAt < b.receivedAt ? -1 : 1; }
    return a.id < b.id ? -1 : 1;
  }

  /* True if this batch can be sold from today: something left, not expired. */
  function isSellable(b, todayYmd) {
    return !!b && Number.isInteger(b.qtyRemaining) && b.qtyRemaining > 0 &&
      expiryState(b.expiry, todayYmd).state !== 'expired';
  }

  /* Works out which batches `qty` items come from. Reads and changes
     nothing. Returns { takes: [{ batchId, qty, expiry }], unrecordedQty }.
     unrecordedQty is how many were sold beyond the stock on record. */
  function allocate(batches, qty, todayYmd) {
    var usable = (batches || [])
      .filter(function (b) { return isSellable(b, todayYmd); })
      .sort(fefoOrder);
    var need = qty;
    var takes = [];
    usable.forEach(function (b) {
      if (need <= 0) { return; }
      var n = Math.min(need, b.qtyRemaining);
      takes.push({ batchId: b.id, qty: n, expiry: b.expiry || '' });
      need -= n;
    });
    return { takes: takes, unrecordedQty: need };
  }

  /* From a list of batches (reads nothing): per product, how many can be
     sold and how many are expired. { productId: { usable, expired } } */
  function sellableByProduct(batches, todayYmd) {
    var out = {};
    (batches || []).forEach(function (b) {
      if (!b || !Number.isInteger(b.qtyRemaining) || b.qtyRemaining <= 0) { return; }
      var s = out[b.productId] || (out[b.productId] = { usable: 0, expired: 0 });
      if (isSellable(b, todayYmd)) { s.usable += b.qtyRemaining; } else { s.expired += b.qtyRemaining; }
    });
    return out;
  }

  function sellableStock() {
    return getAll('batches').then(function (rows) {
      return sellableByProduct(rows, localDate(new Date()));
    });
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

  /* ---------- backup (8a) ---------- */

  var ALL_TABLES = ['products', 'batches', 'sales', 'saleLines', 'settings', 'removals'];

  /* Every record of every table, read in one go. Reading all tables inside
     one read means a sale being saved at the same moment is either fully
     in the backup or not at all, never half. */
  function readAll() {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(ALL_TABLES, 'readonly');
        var out = {};
        ALL_TABLES.forEach(function (name) {
          t.objectStore(name).getAll().onsuccess = function (e) {
            out[name] = e.target.result;
          };
        });
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Reading was cancelled')); };
      });
    });
  }

  /* Asks the browser not to clear this app's data when the device runs
     short of space. Resolves 'yes', 'no' or 'unknown' (older browsers
     cannot be asked). Never fails. */
  function keepDataSafe() {
    try {
      if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
        return Promise.resolve('unknown');
      }
      return navigator.storage.persist().then(function (granted) {
        return granted ? 'yes' : 'no';
      }).catch(function () { return 'unknown'; });
    } catch (e) {
      return Promise.resolve('unknown');
    }
  }

  /* ---------- restore (8c) ---------- */

  var RESTORE_MUST_BE_EMPTY = ['products', 'batches', 'sales', 'saleLines', 'removals'];

  /* How many records this device holds in the tables a restore fills.
     A restore is only allowed when all of these are 0. */
  function restoreBlockers() {
    return Promise.all(RESTORE_MUST_BE_EMPTY.map(function (t) { return count(t); }))
      .then(function (n) {
        var out = {};
        RESTORE_MUST_BE_EMPTY.forEach(function (t, i) { out[t] = n[i]; });
        out.total = n.reduce(function (a, b) { return a + b; }, 0);
        return out;
      });
  }

  /* Loads a checked backup into an EMPTY till, all or nothing.
     data: { products: [...], batches: [...], ... } from a backup file that
     passed Backup.check. Shop details in the file replace the ones here.
     - Inside the same save, it first confirms the tables are empty. If not,
       nothing is written.
     - Records are added, never put over, so an existing record can never
       be replaced.
     Resolves when the save is complete. Does not read back; the screen
     does that with readAll and Backup.sameData. */
  function restoreAll(data) {
    for (var i = 0; i < ALL_TABLES.length; i++) {
      if (!data || !Array.isArray(data[ALL_TABLES[i]])) {
        return Promise.reject(new Error('The backup is missing its ' + ALL_TABLES[i] + '. Nothing was loaded.'));
      }
    }
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(ALL_TABLES, 'readwrite');
        var refused = null;
        var checked = 0;

        function writeAll() {
          var settings = t.objectStore('settings');
          settings.clear();
          data.settings.forEach(function (r) { settings.put(r); });
          RESTORE_MUST_BE_EMPTY.forEach(function (name) {
            var store = t.objectStore(name);
            data[name].forEach(function (r) { store.add(r); });
          });
        }

        RESTORE_MUST_BE_EMPTY.forEach(function (name) {
          t.objectStore(name).count().onsuccess = function (e) {
            if (e.target.result > 0 && !refused) {
              refused = new Error('This device already has data, so nothing was loaded.');
              t.abort();
              return;
            }
            checked += 1;
            if (checked === RESTORE_MUST_BE_EMPTY.length && !refused) { writeAll(); }
          };
        });

        t.oncomplete = function () { resolve(true); };
        /* Any record that fails cancels the whole save; onabort reports it.
           (Never call preventDefault here: that would let the save carry on
           without the failed record.) */
        t.onerror = function () {};
        t.onabort = function () {
          reject(refused || new Error('The backup could not be loaded (' +
            String(t.error && t.error.message ? t.error.message : 'cancelled') +
            '). Nothing was loaded.'));
        };
      });
    });
  }

  /* After a failed restore: empties the five tables again and the shop
     details, then proves they are empty. Only ever called on a device that
     was empty before the restore. */
  function undoRestore() {
    return wipe().then(function () {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction('settings', 'readwrite');
          t.objectStore('settings').clear();
          t.oncomplete = function () { resolve(true); };
          t.onerror = function () { reject(t.error); };
        });
      });
    }).then(restoreBlockers).then(function (left) {
      if (left.total !== 0) {
        return Promise.reject(new Error('The device could not be emptied again.'));
      }
      return true;
    });
  }

  /* ---------- backup reminder (8d) ---------- */

  /* Remembers that a backup was just handed over, then reads it back.
     Kept as one settings row, key 'backup'. */
  function saveBackupNote(info) {
    var now = new Date();
    var note = {
      key: 'backup',
      at: now.toISOString(),
      date: localDate(now),
      fileName: String((info && info.fileName) || ''),
      how: String((info && info.how) || ''),
      counts: (info && info.counts) || null,
      salesKip: info && Number.isSafeInteger(info.salesKip) ? info.salesKip : null
    };
    return put('settings', note).then(function () {
      return get('settings', 'backup');
    }).then(function (saved) {
      if (!saved || saved.at !== note.at) {
        return Promise.reject(new Error('The backup time could not be remembered.'));
      }
      return saved;
    });
  }

  /* The last backup note, or null if no backup was ever made here. */
  function getBackupNote() {
    return get('settings', 'backup');
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

  /* ---------- the cart in progress (9a) ----------
     localStorage is a small notepad the browser keeps for this app. It is
     written at once, so the copy is there even if the app is closed a
     moment later. cart.js decides what the text says; this only keeps it. */

  var CART_KEY = 'till:cart';

  /* Keeps the text and reads it back to prove it. Returns true or false. */
  function keepCartText(text) {
    try {
      global.localStorage.setItem(CART_KEY, String(text));
      return global.localStorage.getItem(CART_KEY) === String(text);
    } catch (e) {
      return false;
    }
  }

  /* The kept text, or null if there is none (or it cannot be read). */
  function keptCartText() {
    try {
      return global.localStorage.getItem(CART_KEY);
    } catch (e) {
      return null;
    }
  }

  /* Throws the kept copy away and proves it is gone. Returns true or false. */
  function dropCart() {
    try {
      global.localStorage.removeItem(CART_KEY);
      return global.localStorage.getItem(CART_KEY) === null;
    } catch (e) {
      return false;
    }
  }

  /* ---------- start fresh before opening (9d) ----------
     Removes all test sales, sale lines, deliveries and removals, keeping
     the products and the shop details. Used once, just before opening.
     Afterwards a settings row, key 'fresh', remembers it and locks it. */

  var FRESH_TABLES = ['sales', 'saleLines', 'batches', 'removals'];
  var FRESH_WORDS = 'START FRESH';
  var FRESH_BACKUP_MINUTES = 10;
  /* Tables whose counts must be the same as in the last backup. Settings is
     left out: saving the backup note itself adds a settings row. */
  var FRESH_SAME_AS_BACKUP = ['products', 'batches', 'sales', 'saleLines', 'removals'];

  /* Why start fresh may not run now, or null if it may. Reads nothing.
     backupNote: the 'backup' settings row (or null)
     freshNote:  the 'fresh' settings row (or null)
     counts:     { products, batches, sales, saleLines, removals } now
     now:        a Date */
  function freshProblem(backupNote, freshNote, counts, now) {
    if (freshNote) {
      return 'This till was already started fresh on ' + String(freshNote.date || '') + '.';
    }
    var at = backupNote && typeof backupNote.at === 'string' ? Date.parse(backupNote.at) : NaN;
    if (isNaN(at)) {
      return 'Make a backup first.';
    }
    var ageMs = now.getTime() - at;
    if (ageMs > FRESH_BACKUP_MINUTES * 60000 || ageMs < -60000) {
      return 'Make a new backup first (the last one is more than ' + FRESH_BACKUP_MINUTES + ' minutes old).';
    }
    var was = backupNote.counts || {};
    var changed = FRESH_SAME_AS_BACKUP.some(function (t) { return was[t] !== counts[t]; });
    if (changed) {
      return 'Something changed after the last backup. Make a new backup first.';
    }
    var nothing = FRESH_TABLES.every(function (t) { return counts[t] === 0; });
    if (nothing) {
      return 'There is nothing to remove.';
    }
    return null;
  }

  /* The 'fresh' settings row, or null if start fresh was never used here. */
  function getFreshNote() {
    return get('settings', 'fresh');
  }

  /* What the Start fresh section needs to show. Never changes anything.
     Resolves { counts, backupNote, freshNote, problem } */
  function freshStatus() {
    return readAll().then(function (all) {
      var counts = {};
      FRESH_SAME_AS_BACKUP.forEach(function (t) { counts[t] = all[t].length; });
      var backupNote = null, freshNote = null;
      all.settings.forEach(function (r) {
        if (r && r.key === 'backup') { backupNote = r; }
        if (r && r.key === 'fresh') { freshNote = r; }
      });
      return {
        counts: counts,
        backupNote: backupNote,
        freshNote: freshNote,
        problem: freshProblem(backupNote, freshNote, counts, new Date())
      };
    });
  }

  /* Does it. typedWords must be START FRESH (spaces around are ignored).
     Everything is checked again inside the same all-or-nothing save, so
     nothing can slip in between the check and the clearing. Then the
     result is read back and proven. Resolves { removed, products }. */
  function startFresh(typedWords) {
    if (String(typedWords || '').trim() !== FRESH_WORDS) {
      return Promise.reject(new Error('Type ' + FRESH_WORDS + ' in capital letters to go ahead.'));
    }
    var names = ['products', 'settings'].concat(FRESH_TABLES);
    var now = new Date();
    var shopBefore = null;
    var removed = null;
    var productCount = null;

    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(names, 'readwrite');
        var refused = null;
        var counts = {};
        var notes = {};
        var waiting = FRESH_SAME_AS_BACKUP.length + 1;

        function oneDone() {
          waiting -= 1;
          if (waiting > 0 || refused) { return; }
          var problem = freshProblem(notes.backup || null, notes.fresh || null, counts, now);
          if (problem) {
            refused = new Error(problem + ' Nothing was removed.');
            t.abort();
            return;
          }
          shopBefore = notes.shop || null;
          productCount = counts.products;
          removed = {};
          FRESH_TABLES.forEach(function (name) {
            removed[name] = counts[name];
            t.objectStore(name).clear();
          });
          t.objectStore('settings').put({
            key: 'fresh',
            at: now.toISOString(),
            date: localDate(now),
            removed: removed,
            products: productCount,
            backupFile: String(notes.backup.fileName || '')
          });
        }

        FRESH_SAME_AS_BACKUP.forEach(function (name) {
          t.objectStore(name).count().onsuccess = function (e) {
            counts[name] = e.target.result;
            oneDone();
          };
        });
        t.objectStore('settings').getAll().onsuccess = function (e) {
          e.target.result.forEach(function (r) { if (r && r.key) { notes[r.key] = r; } });
          oneDone();
        };

        t.oncomplete = function () { resolve(true); };
        t.onerror = function () {};
        t.onabort = function () {
          reject(refused || new Error('Start fresh could not finish (' +
            String(t.error && t.error.message ? t.error.message : 'cancelled') +
            '). Nothing was removed.'));
        };
      });
    }).then(function () {
      dropCart();
      return readAll();
    }).then(function (after) {
      var left = FRESH_TABLES.filter(function (name) { return after[name].length !== 0; });
      var shopAfter = null, fresh = null;
      after.settings.forEach(function (r) {
        if (r.key === 'shop') { shopAfter = r; }
        if (r.key === 'fresh') { fresh = r; }
      });
      var shopSame = JSON.stringify(shopAfter) === JSON.stringify(shopBefore);
      if (left.length || after.products.length !== productCount || !shopSame || !fresh) {
        return Promise.reject(new Error('Start fresh did not finish cleanly. Do not sell. ' +
          'Your backup from a few minutes ago still has everything.'));
      }
      return { removed: removed, products: productCount };
    });
  }

  global.Till = {
    FRESH_WORDS: FRESH_WORDS,
    FRESH_BACKUP_MINUTES: FRESH_BACKUP_MINUTES,
    freshProblem: freshProblem,
    getFreshNote: getFreshNote,
    freshStatus: freshStatus,
    startFresh: startFresh,
    keepCartText: keepCartText,
    keptCartText: keptCartText,
    dropCart: dropCart,
    DB_VERSION: DB_VERSION,
    readAll: readAll,
    saveBackupNote: saveBackupNote,
    getBackupNote: getBackupNote,
    restoreBlockers: restoreBlockers,
    restoreAll: restoreAll,
    undoRestore: undoRestore,
    keepDataSafe: keepDataSafe,
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
    expiryAlerts: expiryAlerts,
    allocate: allocate,
    sellableByProduct: sellableByProduct,
    sellableStock: sellableStock,
    REMOVAL_REASONS: REMOVAL_REASONS,
    MAX_REMOVAL_NOTE: MAX_REMOVAL_NOTE,
    newRemovalId: newRemovalId,
    removalProblem: removalProblem,
    removeStock: removeStock,
    removalsForProduct: removalsForProduct
  };

}(typeof window !== 'undefined' ? window : globalThis));
