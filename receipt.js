/* receipt.js — what goes on a receipt.
   Like cart.js, nothing in here reads or saves data. It is given a saved
   sale and its lines, and works out the receipt from them. That is what
   lets it be checked automatically.

   Every word printed on the receipt is in WORDS below, in one place.
   Some are Lao, some English, none repeated. To change a word, change
   it here only. */

(function (global) {
  'use strict';

  var WORDS = {
    title: '\u0EC3\u0E9A\u0E9A\u0EB4\u0E99',                         // ໃບບິນ (receipt)
    number: 'No.',
    items: 'Items',
    total: '\u0EA5\u0EA7\u0EA1\u0E97\u0EB1\u0E87\u0EDD\u0EBB\u0E94',  // ລວມທັງໝົດ (total)
    cash: '\u0EC0\u0E87\u0EB4\u0E99\u0EAA\u0EBB\u0E94',               // ເງິນສົດ (cash)
    change: '\u0EC0\u0E87\u0EB4\u0E99\u0E97\u0EAD\u0E99',             // ເງິນທອນ (change)
    qr: 'QR',
    reference: 'Ref',
    thanks: '\u0E82\u0EAD\u0E9A\u0EC3\u0E88',                         // ຂອບໃຈ (thank you)
    void: 'VOID'
  };

  var DEFAULT_SHOP_NAME = '(Shop name)';

  function kip(amount) {
    return Math.round(amount).toLocaleString('en-US') + ' \u20AD';
  }

  function two(n) { return String(n).padStart(2, '0'); }

  /* 2026-09-15 becomes 15/09/2026, the way dates are written in Laos. */
  function dateText(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  /* Time on the device's own clock, 24-hour. */
  function timeText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return ''; }
    return two(d.getHours()) + ':' + two(d.getMinutes());
  }

  function isKip(n) {
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  }

  /* Works out everything on the receipt from a saved sale.
     Refuses (throws) if the saved sale does not add up, so a wrong
     receipt is never shown or printed.
     voidRecord (optional, Step 12): the void of this sale, if any. The
     receipt then carries a VOID mark with the date and time of the void. */
  function build(sale, lines, shop, voidRecord) {
    if (!sale || sale.type !== 'sale' || !Number.isInteger(sale.number)) {
      throw new Error('This sale could not be found.');
    }
    /* The cart keeps the newest item at line 1. The receipt lists them in
       the order they were rung up, same as the Pay screen. */
    lines = (lines || []).slice().sort(function (a, b) { return b.lineNo - a.lineNo; });
    if (!lines.length || lines.length !== sale.lineCount) {
      throw new Error('Receipt ' + sale.number + ' is missing some items. It was not shown.');
    }

    var sum = 0;
    var count = 0;
    var items = lines.map(function (l) {
      if (!isKip(l.unitPriceKip) || !Number.isInteger(l.qty) || l.qty < 1 ||
          l.unitPriceKip * l.qty !== l.lineTotalKip) {
        throw new Error('Receipt ' + sale.number + ' has an item that does not add up. It was not shown.');
      }
      sum += l.lineTotalKip;
      count += l.qty;
      return {
        name: String(l.name || ''),
        qtyPrice: l.qty + ' \u00D7 ' + kip(l.unitPriceKip),
        total: kip(l.lineTotalKip)
      };
    });

    if (sum !== sale.totalKip || count !== sale.itemCount) {
      throw new Error('Receipt ' + sale.number + ' does not add up. It was not shown.');
    }

    var rows = [{ label: WORDS.total, value: kip(sale.totalKip), strong: true }];
    if (sale.method === 'cash') {
      if (!isKip(sale.receivedKip) || sale.receivedKip - sale.totalKip !== sale.changeKip) {
        throw new Error('Receipt ' + sale.number + ' has wrong change. It was not shown.');
      }
      rows.push({ label: WORDS.cash, value: kip(sale.receivedKip) });
      rows.push({ label: WORDS.change, value: kip(sale.changeKip) });
    } else if (sale.method === 'qr') {
      rows.push({ label: WORDS.qr, value: kip(sale.totalKip) });
      if (sale.reference) {
        rows.push({ label: WORDS.reference, value: String(sale.reference) });
      }
    } else {
      throw new Error('Receipt ' + sale.number + ' has no payment type. It was not shown.');
    }

    var top = shopLines(shop);

    return {
      shopName: top.name,
      shopPhone: top.phone,
      title: WORDS.title,
      numberText: WORDS.number + ' ' + sale.number,
      when: dateText(sale.date) + '  ' + timeText(sale.at),
      items: items,
      itemsText: WORDS.items + ' ' + count,
      rows: rows,
      voidText: voidRecord && voidRecord.type === 'void' && voidRecord.saleId === sale.id
        ? WORDS.void + '  ' + dateText(voidRecord.date) + '  ' + timeText(voidRecord.at) : '',
      thanks: top.thanks
    };
  }

  /* The shop's own lines. Anything not filled in falls back to the default. */
  function shopLines(shop) {
    var s = shop || {};
    return {
      name: String(s.name || '').trim() || DEFAULT_SHOP_NAME,
      phone: String(s.phone || '').trim(),
      thanks: String(s.thanks || '').trim() || WORDS.thanks
    };
  }

  function esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* The receipt as page content. The look lives in index.html (.rc). */
  function toHtml(r) {
    var html =
      '<div class="rc-shop">' + esc(r.shopName) + '</div>' +
      (r.shopPhone ? '<div class="rc-phone">' + esc(r.shopPhone) + '</div>' : '') +
      '<div class="rc-pair"><span>' + esc(r.title) + '</span><span>' + esc(r.numberText) + '</span></div>' +
      '<div class="rc-when">' + esc(r.when) + '</div>' +
      (r.voidText ? '<div class="rc-void">' + esc(r.voidText) + '</div>' : '') +
      '<div class="rc-rule"></div>';

    r.items.forEach(function (it) {
      html +=
        '<div class="rc-item">' +
          '<div class="rc-name">' + esc(it.name) + '</div>' +
          '<div class="rc-pair"><span>' + esc(it.qtyPrice) + '</span><span>' + esc(it.total) + '</span></div>' +
        '</div>';
    });

    html += '<div class="rc-rule"></div>' +
      '<div class="rc-count">' + esc(r.itemsText) + '</div>';

    r.rows.forEach(function (row) {
      html += '<div class="rc-pair' + (row.strong ? ' rc-strong' : '') + '">' +
        '<span>' + esc(row.label) + '</span><span>' + esc(row.value) + '</span></div>';
    });

    html += '<div class="rc-rule"></div>' +
      '<div class="rc-thanks">' + esc(r.thanks) + '</div>';
    return html;
  }

  global.Receipt = {
    WORDS: WORDS,
    build: build,
    shopLines: shopLines,
    toHtml: toHtml,
    dateText: dateText
  };

}(typeof window !== 'undefined' ? window : globalThis));
