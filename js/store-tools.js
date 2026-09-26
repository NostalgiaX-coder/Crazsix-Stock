import { adMetrics, campaignUntilBudget } from "./ads.js";
// Shared, side-effect-free helpers for reports and store follow-ups.
export function toCsv(rows) {
  const cell = value => {
    let text = String(value ?? "");
    // Quoting alone does not prevent spreadsheet formulas in customer input.
    if (typeof value !== "number" && /^[\s\uFEFF]*[=+@-]/u.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
}

export function cashSummary(transactions, from = '', to = '') {
  const rows = transactions.filter(tx => (!from || tx.date >= from) && (!to || tx.date <= to));
  const sum = type => rows.filter(tx => tx.type === type).reduce((total, tx) => total + tx.amount, 0);
  const sales = rows.filter(tx => tx.category === 'ขายสินค้า' && Number.isFinite(tx.profit));
  return {
    rows, income: sum('income'), expense: sum('expense'),
    cash: sum('income') - sum('expense'),
    sales: sales.reduce((total, tx) => total + tx.amount, 0),
    profit: sales.reduce((total, tx) => total + tx.profit, 0),
    qty: sales.reduce((total, tx) => total + (tx.qty || 0), 0),
  };
}

export function followUpItems({ products, pendingOrders, preorders, transactions, adCampaigns = [] }, today, threshold = 1) {
  const rows = [];
  for (const product of products) for (const variant of product.variants) {
    if (variant.qty <= threshold) rows.push({
      kind: 'stock', id: variant.id, priority: variant.qty <= 0 ? 0 : 1,
      title: [product.name, variant.color, variant.size, variant.type === 'used' ? 'มือสอง' : 'มือหนึ่ง'].filter(Boolean).join(' · '),
      detail: `คงเหลือ ${variant.qty} ชิ้น`, date: '', target: 'stock', workspace: 'inventory',
    });
  }
  for (const order of pendingOrders) rows.push({
    kind: 'supplier', id: order.id, priority: 2, title: order.name,
    detail: `รอรับ ${order.qty} ชิ้น · ${order.note || 'ร้านสั่งเข้ามาขายเอง'}`, date: order.orderDate,
    target: 'stock', workspace: 'pending',
  });
  for (const order of preorders.filter(order => !['completed', 'cancelled'].includes(order.status))) rows.push({
    kind: 'preorder', id: order.id, priority: order.dueDate && order.dueDate < today ? 0 : order.status === 'ready' ? 1 : 2,
    title: `${order.customer} · ${order.name}`,
    detail: `${order.status === 'ready' ? 'พร้อมส่งมอบ' : 'รอส่งมอบ'} · ค้างชำระ ฿${Math.max(0, order.qty * order.unitPrice - order.paidAmount).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`,
    date: order.dueDate || '', target: 'preorder',
  });
  for (const sale of transactions.filter(tx => tx.type === 'installment' && tx.amount - (tx.paidAmount || 0) > 0.001)) rows.push({
    kind: 'installment', id: sale.id, priority: sale.dueDate && sale.dueDate < today ? 0 : 1,
    title: sale.customerNote || sale.desc || 'รายการผ่อนชำระ',
    detail: `ค้างชำระ ฿${(sale.amount - (sale.paidAmount || 0)).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`,
    date: sale.dueDate || '', target: 'installment',
  });
  for (const campaign of adCampaigns.filter(c => ['active', 'paused'].includes(c.status))) {
    const m = adMetrics(campaign, transactions, today);
    const ended = !campaignUntilBudget(campaign) && campaign.endDate < today;
    if (m.remaining <= 0 || ended) rows.push({
      kind: 'ads', id: campaign.id, priority: m.remaining < 0 ? 0 : 1,
      title: campaign.name,
      detail: `${ended ? 'ครบกำหนดแคมเปญ · ' : ''}${m.remaining < 0 ? 'เกินงบ' : m.remaining === 0 ? 'ใช้งบครบแล้ว' : 'งบคงเหลือ'} ฿${Math.abs(m.remaining).toLocaleString('th-TH', { maximumFractionDigits: 2 })}`,
      date: campaign.endDate, target: 'ads',
    });
  }
  return rows.sort((a, b) => a.priority - b.priority || (a.date || '9999').localeCompare(b.date || '9999') || a.title.localeCompare(b.title, 'th'));
}
