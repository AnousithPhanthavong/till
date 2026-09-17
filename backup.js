/* backup.js — what goes into a backup file.
   Like cart.js, receipt.js and report.js, nothing in here reads or saves
   data. It is given everything that was read from the device and turns it
   into the text of one file. That is what lets it be checked automatically.

   Step 8a: making the file.
   Step 8b: checking a file before it is loaded.
   Step 8c: confirming a restore came out exactly like the file.
   Step 8d: the reminder on Home when a backup is due.

   The file is JSON: plain text laid out so that a program can read it back
   exactly. At the top is a header saying what made it, when, and how many
   records of each kind are inside. Loading a file back later (8b, 8c)
   compares the records against that header, so a cut-off or damaged file
   is noticed instead of half loaded. */

(function (global) {
  'use strict';

  var FORMAT = 'baby-shop-till-backup';
  var FORMAT_VERSION = 1;

  /* Every table on the device. A backup always holds all of them. */
  var TABLES = ['products', 'batches', 'sales', 'saleLines', 'settings', 'removals'];

  function two(n) { return String(n).padStart(2, '0'); }

  /* Adds up the money of all sales in the file. Used as a second check
     next to the counts: same count but different money means damage. */
  function salesKip(sales) {
    var sum = 0;
    (sales || []).forEach(function (s) {
      if (s && typeof s.totalKip === 'number') { sum += s.totalKip; }
    });
    if (!Number.isSafeInteger(sum)) {
      throw new Error('The sales total is too large to be right.');
    }
    return sum;
  }

  function countsOf(data) {
    var c = {};
    TABLES.forEach(function (t) { c[t] = data[t].length; });
    return c;
  }

  /* Puts everything into one backup.
     tables: { products: [...], batches: [...], ... } — all six required.
     info:   { dbVersion, build, now (a Date) } */
  function build(tables, info) {
    var data = {};
    TABLES.forEach(function (t) {
      if (!tables || !Array.isArray(tables[t])) {
        throw new Error('The ' + t + ' could not be read, so no backup was made.');
      }
      data[t] = tables[t];
    });
    var now = info && info.now instanceof Date ? info.now : new Date();
    return {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      dbVersion: info && info.dbVersion,
      build: String((info && info.build) || ''),
      createdAt: now.toISOString(),
      createdLocal: now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate()) +
        ' ' + two(now.getHours()) + ':' + two(now.getMinutes()),
      counts: countsOf(data),
      salesKip: salesKip(data.sales),
      data: data
    };
  }

  /* The backup as the text that goes in the file. One record per line
     is not needed; compact text keeps the file small. */
  function toText(backup) {
    return JSON.stringify(backup);
  }

  /* Reads the text back and confirms it holds exactly what was meant to
     go in. Called straight after toText, before the file is offered,
     so a file that would not load back is never handed over. */
  function proveText(text, backup) {
    var back;
    try {
      back = JSON.parse(text);
    } catch (e) {
      throw new Error('The backup file came out unreadable. Nothing was saved. Try again.');
    }
    var ok = back && back.format === FORMAT && back.data &&
      TABLES.every(function (t) {
        return Array.isArray(back.data[t]) &&
          back.data[t].length === backup.counts[t] &&
          back.counts[t] === backup.counts[t];
      }) &&
      salesKip(back.data.sales) === backup.salesKip &&
      back.salesKip === backup.salesKip;
    if (!ok) {
      throw new Error('The backup file did not match what is on this device. Nothing was saved. Try again.');
    }
    return true;
  }

  /* till-backup-2026-09-17-1430.json
     Year first so the files line up in date order in a folder. */
  function fileName(now) {
    var d = now instanceof Date ? now : new Date();
    return 'till-backup-' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
      '-' + two(d.getHours()) + two(d.getMinutes()) + '.json';
  }

  /* 2048 becomes "2 KB". */
  function sizeText(bytes) {
    if (bytes < 1024) { return bytes + ' bytes'; }
    if (bytes < 1024 * 1024) { return Math.round(bytes / 1024) + ' KB'; }
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* ---------- checking a file (8b) ---------- */

  /* Largest file the till will try to read. A small shop's backup stays
     far below this for many years. */
  var MAX_FILE_BYTES = 50 * 1024 * 1024;

  var LABELS = {
    products: 'products', batches: 'deliveries', sales: 'sales',
    saleLines: 'sale lines', settings: 'settings', removals: 'removals'
  };

  /* Money and quantities: any field whose name ends in Kip, or starts with
     qty, or is qty. Empty (null) is allowed; decimals and minus are not. */
  function isNumberField(key) {
    return /Kip$/.test(key) || /^qty/.test(key);
  }
  function many(n, one, more) { return n + ' ' + (n === 1 ? one : more); }

  function badNumber(v) {
    return v !== null && v !== undefined &&
      !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
  }

  /* Reads the text of a backup file and says whether it can be trusted.
     Changes nothing and reads nothing from the device.
     currentDbVersion: the version of the database on this device.
     Returns { ok, problems: [...], notes: [...], info }
       problems — real damage; the file must not be loaded.
       notes    — odd but harmless; loading is still safe. */
  function check(text, currentDbVersion) {
    var problems = [];
    var notes = [];
    var result = { ok: false, problems: problems, notes: notes, info: null };

    var f;
    try {
      f = JSON.parse(String(text || ''));
    } catch (e) {
      problems.push('This file cannot be read. It may be cut off or not a backup at all.');
      return result;
    }
    if (!f || typeof f !== 'object' || f.format !== FORMAT) {
      problems.push('This is not a till backup file.');
      return result;
    }
    if (!Number.isInteger(f.formatVersion) || f.formatVersion > FORMAT_VERSION) {
      problems.push('This backup was made by a newer version of the app. Update this device first.');
      return result;
    }
    if (!Number.isInteger(f.dbVersion) || f.dbVersion > currentDbVersion) {
      problems.push('This backup was made by a newer version of the app. Update this device first.');
      return result;
    }
    var data = f.data;
    var missing = TABLES.filter(function (t) { return !data || !Array.isArray(data[t]); });
    if (missing.length) {
      problems.push('This backup is missing its ' + missing.map(function (t) { return LABELS[t]; }).join(', ') + '.');
      return result;
    }

    var shop = data.settings.filter(function (r) { return r && r.key === 'shop'; })[0];
    result.info = {
      createdLocal: String(f.createdLocal || ''),
      createdAt: String(f.createdAt || ''),
      build: String(f.build || ''),
      dbVersion: f.dbVersion,
      counts: countsOf(data),
      salesKip: null,
      shopName: shop ? String(shop.name || '') : ''
    };

    /* The header must match what is inside. */
    var counts = f.counts || {};
    TABLES.forEach(function (t) {
      if (counts[t] !== data[t].length) {
        problems.push('The ' + LABELS[t] + ' do not match the file\u2019s own count (' +
          data[t].length + ' inside, ' + counts[t] + ' expected). The file is damaged.');
      }
    });

    /* Every record: a proper id, no id twice, whole-number money. */
    var ids = {};
    TABLES.forEach(function (t) {
      var keyName = t === 'settings' ? 'key' : 'id';
      var seen = {};
      var noId = 0, twice = 0, badNum = 0;
      data[t].forEach(function (r) {
        if (!r || typeof r !== 'object' || typeof r[keyName] !== 'string' || !r[keyName]) {
          noId += 1;
          return;
        }
        if (seen[r[keyName]]) { twice += 1; }
        seen[r[keyName]] = r;
        Object.keys(r).forEach(function (k) {
          if (isNumberField(k) && badNumber(r[k])) { badNum += 1; }
        });
      });
      ids[t] = seen;
      if (noId) { problems.push(noId + ' ' + LABELS[t] + ' have no proper id. The file is damaged.'); }
      if (twice) { problems.push(twice + ' ' + LABELS[t] + ' appear twice. The file is damaged.'); }
      if (badNum) { problems.push(badNum + ' amounts in the ' + LABELS[t] + ' are not whole numbers. The file is damaged.'); }
    });

    var kip = null;
    try { kip = salesKip(data.sales); } catch (e) { problems.push(e.message); }
    result.info.salesKip = kip;
    if (kip !== null && f.salesKip !== kip) {
      problems.push('The sales money does not match the file\u2019s own total. The file is damaged.');
    }

    /* Odd but harmless: leftovers from the old test data, and similar. */
    var n = 0;
    data.saleLines.forEach(function (l) { if (l && !ids.sales[l.saleId]) { n += 1; } });
    if (n) { notes.push(many(n, 'sale line belongs', 'sale lines belong') + ' to no sale in the file. Totals ignore this.'); }

    n = 0;
    data.batches.forEach(function (b) { if (b && !ids.products[b.productId]) { n += 1; } });
    if (n) { notes.push(many(n, 'delivery belongs', 'deliveries belong') + ' to a product that is no longer saved.'); }

    n = 0;
    data.removals.forEach(function (r) { if (r && !ids.batches[r.batchId]) { n += 1; } });
    if (n) { notes.push(many(n, 'removal belongs', 'removals belong') + ' to a delivery that is no longer saved (likely the old test product).'); }

    n = 0;
    data.batches.forEach(function (b) {
      if (b && Number.isInteger(b.qtyRemaining) && Number.isInteger(b.qtyReceived) &&
          b.qtyRemaining > b.qtyReceived) { n += 1; }
    });
    if (n) { notes.push(many(n, 'delivery shows', 'deliveries show') + ' more left than was received.'); }

    var numbers = {};
    n = 0;
    data.sales.forEach(function (s) {
      if (s && s.type === 'sale' && Number.isInteger(s.number)) {
        if (numbers[s.number]) { n += 1; }
        numbers[s.number] = true;
      }
    });
    if (n) { notes.push(many(n, 'receipt number is', 'receipt numbers are') + ' used twice.'); }

    result.ok = problems.length === 0;
    return result;
  }

  /* ---------- after a restore (8c) ---------- */

  /* A record as text with its fields in a fixed order, so two copies of
     the same record always give the same text. */
  function canon(v) {
    if (Array.isArray(v)) { return '[' + v.map(canon).join(',') + ']'; }
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter(function (k) { return v[k] !== undefined; })
        .map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  /* Compares what was read back from the device with the file, record by
     record. Returns a list of tables that differ (empty = identical). */
  function differences(fileData, deviceData) {
    var out = [];
    TABLES.forEach(function (t) {
      var keyName = t === 'settings' ? 'key' : 'id';
      var a = (fileData && fileData[t]) || [];
      var b = (deviceData && deviceData[t]) || [];
      if (a.length !== b.length) { out.push(LABELS[t]); return; }
      var byKey = {};
      b.forEach(function (r) { byKey[r[keyName]] = canon(r); });
      var same = a.every(function (r) { return byKey[r[keyName]] === canon(r); });
      if (!same) { out.push(LABELS[t]); }
    });
    return out;
  }

  /* ---------- reminder (8d) ---------- */

  /* A backup counts as due when something changed and the last one is
     this many days old or more. */
  var REMINDER_DAYS = 3;

  function dayNumber(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : null;
  }

  /* How many things were added or changed after `sinceIso` (an ISO time).
     With no time, everything counts. */
  function changesSince(data, sinceIso) {
    var since = String(sinceIso || '');
    var n = 0;
    function after(t) { return typeof t === 'string' && t > since; }
    (data.sales || []).forEach(function (r) { if (r && after(r.at)) { n += 1; } });
    (data.batches || []).forEach(function (r) { if (r && after(r.receivedAt)) { n += 1; } });
    (data.removals || []).forEach(function (r) { if (r && after(r.at)) { n += 1; } });
    (data.products || []).forEach(function (r) {
      if (r && (after(r.createdAt) || after(r.updatedAt))) { n += 1; }
    });
    (data.settings || []).forEach(function (r) {
      if (r && r.key === 'shop' && after(r.updatedAt)) { n += 1; }
    });
    return n;
  }

  /* What Home should say about backups.
     data: everything on the device (as from readAll).
     note: the saved { at, date } of the last backup, or null.
     Returns { state, days, changes }
       state 'empty' - nothing on the device worth backing up
             'never' - data exists, no backup yet (due)
             'due'   - changes since, and REMINDER_DAYS or more old
             'ok'    - otherwise
       days - whole days since the last backup (null if never). */
  function reminder(data, note, todayYmd) {
    var hasData = ['products', 'batches', 'sales', 'removals'].some(function (t) {
      return data && data[t] && data[t].length > 0;
    });
    var at = note && typeof note.at === 'string' ? note.at : '';
    var changes = changesSince(data || {}, at);
    if (!at) {
      return { state: hasData ? 'never' : 'empty', days: null, changes: changes };
    }
    var a = dayNumber(note.date);
    var b = dayNumber(todayYmd);
    var days = (a === null || b === null) ? null : Math.max(0, Math.round(b - a));
    var due = changes > 0 && (days === null || days >= REMINDER_DAYS);
    return { state: due ? 'due' : 'ok', days: days, changes: changes };
  }

  /* "today", "yesterday", "5 days ago". */
  function agoText(days) {
    if (days === null || days === undefined) { return 'unknown'; }
    if (days === 0) { return 'today'; }
    if (days === 1) { return 'yesterday'; }
    return days + ' days ago';
  }

  global.Backup = {
    REMINDER_DAYS: REMINDER_DAYS,
    changesSince: changesSince,
    reminder: reminder,
    agoText: agoText,
    differences: differences,
    MAX_FILE_BYTES: MAX_FILE_BYTES,
    check: check,
    FORMAT: FORMAT,
    FORMAT_VERSION: FORMAT_VERSION,
    TABLES: TABLES,
    build: build,
    toText: toText,
    proveText: proveText,
    fileName: fileName,
    sizeText: sizeText,
    salesKip: salesKip
  };

}(typeof window !== 'undefined' ? window : globalThis));
