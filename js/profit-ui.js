import { personalUseAmount, saleProfit } from './sale-finance.js';
import { money } from './preorders.js';

export function profitBreakdown(sale) {
  const shipping = sale.shipping || 0;
  const commission = sale.commission || 0;
  // Historical margin is authoritative, including shipping corrections.
  const gross = money(sale.profit + shipping + commission);
  return { sale, revenue: sale.amount, cost: money(sale.amount - gross), gross,
    shipping, commission, personal: personalUseAmount(sale), net: saleProfit(sale) };
}

export function renderProfitTab({ from, to }, { esc }) {
  return `<div class="panel"><h2>กำไรจากการขายแต่ละรายการ</h2>
    <div class="task-filters"><div class="field"><label for="profit-from">ตั้งแต่วันที่</label><input id="profit-from" type="date" value="${esc(from)}"></div>
    <div class="field"><label for="profit-to">ถึงวันที่</label><input id="profit-to" type="date" value="${esc(to)}"></div>
    <button class="btn btn-ghost" id="profit-clear">ทุกช่วงเวลา</button></div>
    <p id="profit-error" class="hint" role="status"></p>
    <p class="hint">กำไรก่อนค่าใช้จ่าย = ยอดขาย − ต้นทุนสินค้าที่ขาย ส่วนกำไรหลังค่าใช้จ่ายรายรายการ หักค่าส่ง ค่ากลาง และเงินแบ่งใช้ส่วนตัวเพิ่มแล้ว กำไรต่อชิ้นเป็นค่าเฉลี่ยในรายการนั้น</p>
    <p class="hint">รวมยอดขายผ่อนชำระเต็มจำนวนและ pre-order ที่ส่งมอบแล้ว แม้ยังรับเงินไม่ครบ ไม่รวมรายการยกเลิกหรือรายการที่ลบ</p></div>
    <div id="profit-results"></div>`;
}

export function wireProfitTab(transactions, filter, { fmt, esc, metric, isAdSpend, isManualTransaction }) {
  const from = document.getElementById('profit-from');
  if (!from) return;
  const to = document.getElementById('profit-to');
  const results = document.getElementById('profit-results');
  const update = () => {
    filter.from = from.value; filter.to = to.value;
    const invalid = filter.from && filter.to && filter.from > filter.to;
    document.getElementById('profit-error').textContent = invalid ? 'วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด' : '';
    if (invalid) { results.innerHTML = ''; return; }
    const period = transactions.filter(tx => (!filter.from || tx.date >= filter.from) && (!filter.to || tx.date <= filter.to));
    const rows = period.filter(tx => tx.category === 'ขายสินค้า' && Number.isFinite(tx.profit))
      .sort((a, b) => b.date.localeCompare(a.date)).map(profitBreakdown);
    const sum = key => money(rows.reduce((total, row) => total + row[key], 0));
    const overhead = period.filter(tx => tx.type === 'expense' && (isAdSpend(tx) || isManualTransaction(tx)));
    const ads = money(overhead.filter(isAdSpend).reduce((total, tx) => total + tx.amount, 0));
    const other = money(overhead.filter(tx => !isAdSpend(tx)).reduce((total, tx) => total + tx.amount, 0));
    const colored = amount => `<strong style="color:var(--${amount < 0 ? 'red' : 'green'})">${fmt(amount)}</strong>`;
    results.innerHTML = `<section class="stats range-stats" aria-label="สรุปกำไร">
      ${metric('ยอดขาย', fmt(sum('revenue')), `${rows.length} รายการ · ${rows.reduce((n, r) => n + (r.sale.qty || 0), 0)} ชิ้น`, 'bag')}
      ${metric('กำไรก่อนค่าใช้จ่าย', fmt(sum('gross')), 'หักต้นทุนสินค้าที่ขายแล้ว', 'chart')}
      ${metric('ค่าใช้จ่ายรายรายการ', fmt(money(sum('shipping') + sum('commission') + sum('personal'))), 'ค่าส่ง + ค่ากลาง + แบ่งใช้ส่วนตัว', 'down')}
      ${metric('กำไรหลังค่าใช้จ่ายรายรายการ', fmt(sum('net')), 'ก่อนค่าแอดและค่าใช้จ่ายรวมของร้าน', 'wallet')}</section>
      <div class="panel"><h2>รายละเอียดกำไรแต่ละรายการ</h2><p class="hint">เลื่อนตารางแนวนอนเพื่อดูค่าใช้จ่ายและกำไรต่อชิ้น</p>${rows.length ? `<div class="profit-table-wrap" tabindex="0" role="region" aria-label="ตารางกำไร เลื่อนแนวนอนเพื่อดูทุกคอลัมน์"><table id="profit-table"><thead><tr>${['วันที่', 'รายการขาย', 'จำนวน', 'ยอดขาย', 'ต้นทุนรวม', 'กำไรก่อนค่าใช้จ่าย', 'ค่าส่ง', 'ค่ากลาง', 'แบ่งใช้ส่วนตัว', 'กำไรหลังค่าใช้จ่าย', 'กำไรหลังค่าใช้จ่าย/ชิ้น'].map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr><td>${esc(row.sale.date)}</td><td>${esc(row.sale.desc || row.sale.productName || 'รายการขาย')}${row.sale.type === 'installment' ? '<span class="tag installment">ผ่อนชำระ</span>' : ''}</td><td class="num">${row.sale.qty || 0}</td>${['revenue', 'cost', 'gross', 'shipping', 'commission', 'personal', 'net'].map(key => `<td class="num">${['gross', 'net'].includes(key) ? colored(row[key]) : fmt(row[key])}</td>`).join('')}<td class="num">${row.sale.qty > 0 ? colored(money(row.net / row.sale.qty)) : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">ยังไม่มีรายการขายในช่วงวันที่เลือก</div>'}</div>
      <div class="panel"><h2>หลังหักค่าใช้จ่ายรวมของร้าน</h2><p class="hint">ค่าแอดและรายจ่ายอื่นที่บันทึกในบัญชีในช่วงวันที่เลือก หักในยอดรวมด้านล่าง ยังไม่เฉลี่ยลงแต่ละรายการขาย ต้นทุนซื้อเข้า ค่าส่ง และค่ากลางที่ระบบบันทึกจากการขายจะไม่ถูกหักซ้ำ เงินสำรองยิงแอดยังไม่ใช่ค่าใช้จ่าย</p>
      <section class="stats range-stats">${metric('ค่าแอด', fmt(ads), 'ตามวันที่บันทึกค่าแอด รวมยอดอัตโนมัติซึ่งเป็นประมาณการ', 'down')}${metric('ค่าใช้จ่ายอื่นของร้าน', fmt(other), 'รายจ่ายที่บันทึกเพิ่มเติม เช่น ค่าเช่า', 'down')}${metric('กำไรคงเหลือหลังค่าใช้จ่ายที่บันทึก', fmt(money(sum('net') - ads - other)), 'กำไรหลังค่าใช้จ่ายรายรายการ − ค่าแอด − ค่าใช้จ่ายอื่น', 'wallet')}</section>
      ${overhead.length ? `<details><summary>ดูค่าใช้จ่ายที่นำมาหัก (${overhead.length} รายการ)</summary><ul>${overhead.map(tx => `<li>${esc(tx.date)} · ${esc(tx.category)} · ${esc(tx.desc || '')} — ${fmt(tx.amount)}</li>`).join('')}</ul></details>` : ''}</div>`;
  };
  from.onchange = update; to.onchange = update;
  document.getElementById('profit-clear').onclick = () => { from.value = ''; to.value = ''; update(); };
  update();
}
