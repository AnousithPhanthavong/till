/* report.js — adding up saved sales.
   Like cart.js and receipt.js, nothing in here reads or saves data. It is
   given the list of saved sales and adds them up. That is what lets it be
   checked automatically.

   Step 7a: totals for each day, and the sales on one day.

   Only records marked as sales are counted. When voids and refunds are
   added later they will be their own kind of record, so they can never be
   counted as money in by mistake. A sale that does not look right is left
   out and counted in `skipped`, so the screen can say so. */

(function (global) {
  'use strict';

  function isKip(n) {
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  }

  /* True if a saved record is a proper sale that can be added up. */
  function isCountable(s) {
    return !!s &&
      s.type === 'sale' &&
      Number.isInteger(s.number) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || '')) &&
      isKip(s.totalKip) && s.totalKip > 0 &&
      Number.isInteger(s.itemCount) && s.itemCount > 0 &&
      (s.method === 'cash' || s.method === 'qr');
  }

  function add(a, b) {
    var sum = a + b;
    if (!Number.isSafeInteger(sum)) {
      throw new Error('The totals are too large to be right.');
    }
    return sum;
  }

  function emptyDay(date) {
    return { date: date, count: 0, totalKip: 0, cashKip: 0, qrKip: 0, itemCount: 0 };
  }

  /* One entry per day that had sales, newest day first:
     { date, count, totalKip, cashKip, qrKip, itemCount }
     Returns { days, skipped }. */
  function dailyTotals(sales) {
    var byDate = {};
    var skipped = 0;
    (sales || []).forEach(function (s) {
      if (!isCountable(s)) {
        /* Anything that is not a sale at all (a future void) is not "skipped". */
        if (s && s.type === 'sale') { skipped += 1; }
        return;
      }
      var d = byDate[s.date] || (byDate[s.date] = emptyDay(s.date));
      d.count += 1;
      d.totalKip = add(d.totalKip, s.totalKip);
      d.itemCount = add(d.itemCount, s.itemCount);
      if (s.method === 'cash') { d.cashKip = add(d.cashKip, s.totalKip); }
      else { d.qrKip = add(d.qrKip, s.totalKip); }
    });
    var days = Object.keys(byDate).sort().reverse().map(function (k) { return byDate[k]; });
    return { days: days, skipped: skipped };
  }

  /* The totals for one day. A day with no sales gives all zeros. */
  function dayTotals(sales, date) {
    var found = dailyTotals(sales).days.filter(function (d) { return d.date === date; })[0];
    return found || emptyDay(date);
  }

  /* The sales on one day, newest (highest receipt number) first. */
  function salesOnDay(sales, date) {
    return (sales || [])
      .filter(function (s) { return isCountable(s) && s.date === date; })
      .sort(function (a, b) { return b.number - a.number; });
  }

  var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* 2026-09-17 becomes "Thu". Worked out from the date itself, not the clock. */
  function weekday(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) { return ''; }
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    return WEEKDAYS[d.getDay()];
  }

  global.Report = {
    isCountable: isCountable,
    dailyTotals: dailyTotals,
    dayTotals: dayTotals,
    salesOnDay: salesOnDay,
    weekday: weekday
  };

}(typeof window !== 'undefined' ? window : globalThis));
