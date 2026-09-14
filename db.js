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

      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('Another copy of the till is open')); };
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

  function wipe() {
    opening = null;
    return new Promise(function (resolve, reject) {
      var request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = function () { resolve(true); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { resolve(true); };
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
    byIndex: byIndex,
    count: count,
    counts: counts,
    batchesForProduct: batchesForProduct,
    wipe: wipe,
    newId: newId,
    formatKip: formatKip,
    today: today,
    selfTest: selfTest,
    lastSaleSummary: lastSaleSummary
  };

}(typeof window !== 'undefined' ? window : globalThis));
