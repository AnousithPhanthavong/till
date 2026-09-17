/* backup.js — what goes into a backup file.
   Like cart.js, receipt.js and report.js, nothing in here reads or saves
   data. It is given everything that was read from the device and turns it
   into the text of one file. That is what lets it be checked automatically.

   Step 8a: making the file.

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

  global.Backup = {
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
