/* report.js — adding up saved sales.
   Like cart.js and receipt.js, nothing in here reads or saves data. It is
   given the list of saved sales and adds them up. That is what lets it be
   checked automatically.

   Step 7a: totals for each day, and the sales on one day.
   Step 7b: totals for each month, and for the last 12 months.
   Step 7c: items sold with no stock on record, and stock removals.

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

  /* ---------- turnover (7b) ---------- */

  function parseYmd(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) { throw new Error('The date on this device could not be read.'); }
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }

  function two(n) { return String(n).padStart(2, '0'); }

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  /* The day after the same date one year earlier.
     2026-09-17 gives 2025-09-18. On 29 February, a year earlier is taken
     as 28 February, so 2028-02-29 gives 2027-03-01. */
  function yearStart(todayYmd) {
    var t = parseYmd(todayYmd);
    var y = t.y - 1;
    var d = Math.min(t.d, daysInMonth(y, t.m));
    var next = new Date(Date.UTC(y, t.m - 1, d + 1));
    return next.getUTCFullYear() + '-' + two(next.getUTCMonth() + 1) + '-' + two(next.getUTCDate());
  }

  /* Sales from yearStart(today) up to and including today.
     Returns { from, to, count, totalKip, cashKip, qrKip, later, skipped }.
     `later` counts sales dated after today, which means the device clock
     was wrong at some point. They are not in the total. */
  function lastTwelveMonths(sales, todayYmd) {
    var from = yearStart(todayYmd);
    var r = { from: from, to: todayYmd, count: 0, totalKip: 0, cashKip: 0, qrKip: 0, later: 0, skipped: 0 };
    var days = dailyTotals(sales);
    r.skipped = days.skipped;
    days.days.forEach(function (d) {
      if (d.date > todayYmd) { r.later += d.count; return; }
      if (d.date < from) { return; }
      r.count += d.count;
      r.totalKip = add(r.totalKip, d.totalKip);
      r.cashKip = add(r.cashKip, d.cashKip);
      r.qrKip = add(r.qrKip, d.qrKip);
    });
    return r;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* "2026-09" becomes "Sep 2026". */
  function monthName(ym) {
    var m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
  }

  /* The 12 calendar months up to and including this one, newest first.
     Months with no sales are included, with zeros.
     Each: { month: 'YYYY-MM', count, totalKip, cashKip, qrKip, soFar } */
  function monthTotals(sales, todayYmd) {
    var t = parseYmd(todayYmd);
    var list = [];
    var byMonth = {};
    for (var i = 0; i < 12; i++) {
      var y = t.y;
      var m = t.m - i;
      while (m < 1) { m += 12; y -= 1; }
      var key = y + '-' + two(m);
      var row = { month: key, count: 0, totalKip: 0, cashKip: 0, qrKip: 0, soFar: i === 0 };
      byMonth[key] = row;
      list.push(row);
    }
    dailyTotals(sales).days.forEach(function (d) {
      if (d.date > todayYmd) { return; }
      var row = byMonth[d.date.slice(0, 7)];
      if (!row) { return; }
      row.count += d.count;
      row.totalKip = add(row.totalKip, d.totalKip);
      row.cashKip = add(row.cashKip, d.cashKip);
      row.qrKip = add(row.qrKip, d.qrKip);
    });
    return list;
  }

  /* ---------- stock gaps and removals (7c) ---------- */

  /* Items sold beyond the stock on record, one entry per product.
     Only lines of proper sales count. Sales saved before stock was taken at
     checkout have no unrecordedQty and are not looked at.
     `batches` is used to see whether a delivery has been added since the
     last such sale: { productId, receivedAt }.
     Each: { productId, name, qty, saleCount, lastAt, lastDate, deliveredSince }
     Not-yet-fixed products first, then the most recent first. */
  function stockGaps(sales, lines, batches) {
    var saleById = {};
    (sales || []).forEach(function (s) {
      if (isCountable(s)) { saleById[s.id] = s; }
    });

    var byProduct = {};
    (lines || []).forEach(function (l) {
      if (!l || !Number.isInteger(l.unrecordedQty) || l.unrecordedQty < 1) { return; }
      var sale = saleById[l.saleId];
      if (!sale) { return; }
      var g = byProduct[l.productId];
      if (!g) {
        g = byProduct[l.productId] = {
          productId: l.productId, name: String(l.name || ''), qty: 0,
          saleCount: 0, lastAt: '', lastDate: '', deliveredSince: false, sales: {}
        };
      }
      g.qty = add(g.qty, l.unrecordedQty);
      if (!g.sales[sale.id]) { g.sales[sale.id] = true; g.saleCount += 1; }
      if (String(sale.at) > g.lastAt) {
        g.lastAt = String(sale.at);
        g.lastDate = sale.date;
        g.name = String(l.name || g.name);
      }
    });

    (batches || []).forEach(function (b) {
      var g = b && byProduct[b.productId];
      if (g && String(b.receivedAt || '') > g.lastAt) { g.deliveredSince = true; }
    });

    return Object.keys(byProduct).map(function (id) {
      var g = byProduct[id];
      delete g.sales;
      return g;
    }).sort(function (a, b) {
      if (a.deliveredSince !== b.deliveredSince) { return a.deliveredSince ? 1 : -1; }
      if (a.lastAt !== b.lastAt) { return a.lastAt < b.lastAt ? 1 : -1; }
      return a.name.localeCompare(b.name);
    });
  }

  /* All stock removals, newest first, and how many items per reason.
     Returns { list, byReason: { damaged: n, ... }, totalQty } */
  function removalSummary(removals) {
    var list = (removals || []).filter(function (r) {
      return r && r.type === 'removal' && Number.isInteger(r.qty) && r.qty > 0;
    }).slice().sort(function (a, b) {
      return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0);
    });
    var byReason = {};
    var totalQty = 0;
    list.forEach(function (r) {
      byReason[r.reason] = add(byReason[r.reason] || 0, r.qty);
      totalQty = add(totalQty, r.qty);
    });
    return { list: list, byReason: byReason, totalQty: totalQty };
  }

  global.Report = {
    stockGaps: stockGaps,
    removalSummary: removalSummary,
    yearStart: yearStart,
    lastTwelveMonths: lastTwelveMonths,
    monthTotals: monthTotals,
    monthName: monthName,
    isCountable: isCountable,
    dailyTotals: dailyTotals,
    dayTotals: dayTotals,
    salesOnDay: salesOnDay,
    weekday: weekday
  };

}(typeof window !== 'undefined' ? window : globalThis));
