/* db.js — where the till keeps its data on the iPad.
   Every screen built later talks to the data through this one file.

   Money is always whole kip, stored as a plain number. Never decimals.
   Dates are stored as text, YYYY-MM-DD, so they sort correctly. */

(function (global) {
  'use strict';

  var DB_NAME = 'till';
  var DB_VERSION = 1;

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

  /* ---------- temporary self-test ----------
     Writes one product, two batches with different expiry dates, and one
     sale of 3 units. The sale must take the 2 units from the batch that
     expires first, then 1 from the later batch.

     This is throwaway proof that the tables work. The real selling screen
     is built in a later step, and this whole section gets deleted then. */

  function selfTest() {
    var now = new Date().toISOString();

    var product = {
      id: newId('prod'),
      barcode: '8850000000001',
      name: 'Test formula 800g',
      costKip: 145000,
      priceKip: 185000,
      tracksExpiry: true,
      active: true,
      createdAt: now
    };

    var batchEarly = {
      id: newId('batch'),
      productId: product.id,
      batchCode: 'LOT-A',
      expiry: '2026-12-31',
      qtyRemaining: 2,
      costKip: 145000,
      receivedAt: now
    };

    var batchLate = {
      id: newId('batch'),
      productId: product.id,
      batchCode: 'LOT-B',
      expiry: '2027-06-30',
      qtyRemaining: 10,
      costKip: 148000,
      receivedAt: now
    };

    return put('products', product)
      .then(function () { return putMany('batches', [batchEarly, batchLate]); })
      .then(function () { return batchesForProduct(product.id); })
      .then(function (available) {
        var wanted = 3;
        var lines = [];
        var touched = [];
        var saleId = newId('sale');

        available.forEach(function (batch) {
          if (wanted <= 0) { return; }
          var take = Math.min(wanted, batch.qtyRemaining);
          wanted -= take;
          batch.qtyRemaining -= take;
          touched.push(batch);
          lines.push({
            id: newId('line'),
            saleId: saleId,
            productId: product.id,
            batchId: batch.id,
            name: product.name,
            batchCode: batch.batchCode,
            expiry: batch.expiry,
            qty: take,
            unitPriceKip: product.priceKip,
            lineTotalKip: take * product.priceKip
          });
        });

        if (wanted > 0) {
          return Promise.reject(new Error('Not enough stock in the test batches'));
        }

        var total = lines.reduce(function (sum, l) { return sum + l.lineTotalKip; }, 0);
        var cashGiven = 600000;

        var sale = {
          id: saleId,
          at: now,
          day: today(),
          totalKip: total,
          payment: 'cash',
          cashGivenKip: cashGiven,
          changeKip: cashGiven - total,
          voidOf: null,
          refundOf: null
        };

        return putMany('batches', touched)
          .then(function () { return putMany('saleLines', lines); })
          .then(function () { return put('sales', sale); })
          .then(function () { return { sale: sale, lines: lines, batches: touched }; });
      });
  }

  /* Plain-language summary of the most recent sale, for the screen. */
  function lastSaleSummary() {
    return getAll('sales').then(function (sales) {
      if (!sales.length) { return null; }
      sales.sort(function (a, b) { return a.at < b.at ? 1 : -1; });
      var sale = sales[0];
      return byIndex('saleLines', 'saleId', sale.id).then(function (lines) {
        return getAll('batches').then(function (batches) {
          return { sale: sale, lines: lines, batches: batches };
        });
      });
    });
  }

  global.Till = {
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
    selfTest: selfTest,
    lastSaleSummary: lastSaleSummary
  };

}(typeof window !== 'undefined' ? window : globalThis));
