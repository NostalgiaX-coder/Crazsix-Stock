import { money } from './preorders.js';
import { campaignHasProduct } from './ads.js';
import { measurementsOf, measurementLabel } from './inventory-tools.js';
import { validPersonalPercent } from './shipments.js';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const cash = value => Number.isFinite(value) && value >= 0 && value <= 1e12 && Math.abs(value - money(value)) < 0.000001;
const labelFor = (product, variant) => `${product.name} · ${variant.color || '-'} · ${variant.size || '-'} · ${variant.type === 'used' ? 'มือ2' : 'มือ1'}${measurementLabel(variant) ? ' · ' + measurementLabel(variant) : ''}`;

// Prepare every line on a copy. A failed later line must never sell earlier lines.
// Both single-item checkout and the cart use this same accounting path.
export function prepareSales(state, rows, { id, date, dueDate, label = labelFor }) {
  check(Array.isArray(rows) && rows.length > 0, 'เลือกสินค้าอย่างน้อย 1 รายการ');
  const products = structuredClone(state.products), transactions = structuredClone(state.transactions);
  const sales = [];
  let usesCampaign = false;
  for (const row of rows) {
    const product = products.find(p => p.variants.some(v => v.id === row.variantId));
    const variant = product?.variants.find(v => v.id === row.variantId);
    check(variant, 'ไม่พบสินค้า กรุณาเลือกใหม่');
    const original = state.products.flatMap(p => p.variants).find(v => v.id === row.variantId);
    if (row.expectedVariant) check(JSON.stringify(original) === row.expectedVariant, 'ข้อมูลสินค้าในตะกร้าเปลี่ยนไป กรุณานำรายการออกแล้วเลือกใหม่');
    const data = row.data, qty = Number(data.qty), sellPrice = Number(data.sellPrice);
    const shipping = Number(data.shipping || 0), commission = Number(data.commission || 0);
    const installment = !!data.installment, deposit = Number(data.deposit || 0), dueDays = Number(data.dueDays || 30);
    check(Number.isSafeInteger(qty) && qty > 0, 'ระบุจำนวนที่จะขายเป็นจำนวนเต็มมากกว่า 0');
    check(qty <= variant.qty, `สินค้าคงเหลือไม่พอ (${product.name} เหลือ ${variant.qty} ชิ้น)`);
    check(cash(sellPrice) && sellPrice > 0 && cash(money(sellPrice * qty)), 'ระบุราคาขายจริงให้ถูกต้อง');
    check(cash(shipping) && cash(commission), 'ค่าส่งและค่ากลางต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป');
    const revenue = money(sellPrice * qty);
    check(!installment || (cash(deposit) && deposit <= revenue && Number.isSafeInteger(dueDays) && dueDays >= 1 && dueDays <= 3650), 'มัดจำต้องตั้งแต่ 0 และไม่เกินยอดขาย วันครบกำหนดต้องเป็นจำนวนเต็ม 1–3650 วัน');
    const campaign = data.adCampaignId ? state.adCampaigns.find(c => c.id === data.adCampaignId && campaignHasProduct(c, product.id)) : null;
    check(!data.adCampaignId || campaign, 'ไม่พบแคมเปญของสินค้านี้ กรุณาเลือกใหม่');
    const rate = campaign ? (String(data.adReservePerUnit ?? '').trim() === '' ? campaign.reservePerUnit : Number(data.adReservePerUnit)) : null;
    check(rate == null || (cash(rate) && cash(money(rate * qty))), 'ยอดแบ่งยิงแอดต้องตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
    const personalUsePercent = Number(data.personalUsePercent || 0);
    check(validPersonalPercent(personalUsePercent), 'เปอร์เซ็นต์เงินใช้ส่วนตัวต้องอยู่ระหว่าง 0–100 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
    const customerNote = String(data.customerNote || '').trim();
    check(customerNote.length <= 2000, 'ข้อมูลผู้รับต้องไม่เกิน 2,000 ตัวอักษร');
    variant.qty -= qty;
    const description = label(product, variant);
    const sale = {
      id: id(), type: installment ? 'installment' : 'income', category: 'ขายสินค้า',
      desc: description + ' x' + qty + (installment ? (customerNote ? ' — ' + customerNote : '') + ' (ผ่อนชำระ)' : ''),
      customerNote, deliveryStatus: 'pending', amount: revenue, date, productId: variant.id,
      qty, unitPrice: sellPrice, unitCost: variant.cost, shipping, commission,
      profit: money(revenue - variant.cost * qty - shipping - commission),
      stockProductId: product.id, ...measurementsOf(variant), personalUsePercent,
      ...(campaign ? { adCampaignId: campaign.id, ...(rate != null ? { adReservePerUnit: rate } : {}) } : {}),
      ...(installment ? { paidAmount: deposit, dueDate: dueDate(dueDays) } : {})
    };
    transactions.unshift(sale);
    if (installment && deposit > 0) transactions.unshift({ id: id(), type: 'income', category: 'รับชำระค่าผ่อน (มัดจำแรก)', desc: description, amount: deposit, date, installmentId: sale.id, productId: variant.id });
    for (const [amount, category] of [[shipping, 'ค่าส่ง'], [commission, 'ค่ากลาง']]) {
      if (amount > 0) transactions.unshift({ id: id(), type: 'expense', category, desc: description + ' x' + qty, amount, date, productId: variant.id });
    }
    sales.push(sale);
    usesCampaign ||= !!campaign;
  }
  return { products, transactions, sales, usesCampaign };
}

export function prepareInstallmentPayments(transactions, rows, { id, date }) {
  check(Array.isArray(rows) && rows.length > 0, 'เลือกรายการรับชำระอย่างน้อย 1 รายการ');
  const next = structuredClone(transactions), seen = new Set();
  for (const row of rows) {
    check(!seen.has(row.saleId), 'เลือกรายการรับชำระซ้ำ'); seen.add(row.saleId);
    const sale = next.find(t => t.id === row.saleId && t.type === 'installment' && t.deliveryStatus !== 'cancelled');
    check(sale, 'ไม่พบรายการผ่อนที่รับชำระได้');
    if (row.expectedSale) check(JSON.stringify(sale) === row.expectedSale, 'ยอดผ่อนเปลี่ยนไป กรุณาตรวจสอบรายการล่าสุด');
    const amount = Number(row.amount), remaining = money(sale.amount - (sale.paidAmount || 0));
    check(cash(amount) && amount > 0, 'ระบุจำนวนเงินให้ถูกต้อง');
    check(amount <= remaining, 'จำนวนเงินเกินยอดค้างชำระ');
    sale.paidAmount = money((sale.paidAmount || 0) + amount);
    next.unshift({ id: id(), type: 'income', category: 'รับชำระค่าผ่อน', desc: sale.desc, amount, date, installmentId: sale.id, productId: sale.productId });
  }
  return next;
}
