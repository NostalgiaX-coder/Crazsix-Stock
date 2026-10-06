import { money } from './preorders.js';
import { allocateCashCosts } from './inventory-tools.js';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const cash = value => Number.isFinite(value) && value >= 0 && value <= 1e12 && Math.abs(value - money(value)) < 1e-7;
export function receivingCandidates(state) {
  return [
    ...state.preorders.filter(o => o.status === 'ordered' && (o.receivedQty || 0) < o.qty).map(o => ({ kind: 'preorder', id: o.id, order: o, remaining: o.qty - (o.receivedQty || 0), label: `พรีออเดอร์ · ${o.customer} · ${o.name} · ${o.color || ''} ${o.size || ''}` })),
    ...state.pendingOrders.map(o => ({ kind: 'stock', id: o.id, order: o, remaining: o.qty, label: `เข้าสต็อก · ${o.name} · ${o.color || ''} ${o.size || ''}` })),
  ];
}
export function allocateReceiving(total, mode, rows) {
  check(cash(total), 'ค่าส่งรวมต้องตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
  check(['quantity', 'weight', 'manual'].includes(mode), 'เลือกวิธีแบ่งค่าส่ง');
  check(rows.length > 0, 'เลือกสินค้าที่มาถึงอย่างน้อย 1 รายการ');
  check(rows.every(r => Number.isSafeInteger(r.qty) && r.qty > 0), 'จำนวนรับต้องเป็นจำนวนเต็มมากกว่า 0');
  if (mode === 'manual') {
    check(rows.every(r => cash(r.share)), 'ส่วนแบ่งค่าส่งต้องตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
    check(money(rows.reduce((s, r) => s + r.share, 0)) === total, 'ยอดแบ่งค่าส่งต้องรวมเท่ากับค่าส่งทั้งล็อต');
    return rows.map(r => r.share);
  }
  const weights = rows.map(r => mode === 'quantity' ? r.qty : r.weight);
  check(weights.every(w => Number.isFinite(w) && w > 0 && w <= 1e12), 'ระบุน้ำหนักรวมของสินค้าที่รับในแต่ละรายการให้มากกว่า 0');
  const sum = weights.reduce((a, b) => a + b, 0);
  return allocateCashCosts(weights.map(w => total * w / sum));
}
export function prepareReceivingLot(state, data) {
  const candidates = receivingCandidates(state);
  check(new Set(data.rows.map(r => r.kind + ':' + r.id)).size === data.rows.length, 'พบรายการรับของซ้ำ');
  const shares = allocateReceiving(data.total, data.mode, data.rows);
  return data.rows.map((row, index) => {
    const candidate = candidates.find(c => c.kind === row.kind && c.id === row.id);
    check(candidate && row.qty <= candidate.remaining, 'จำนวนรับเกินจำนวนรอรับ หรือรายการเปลี่ยนแปลงแล้ว');
    check(row.expected === JSON.stringify(candidate.order), 'รายการเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดแล้วเลือกใหม่');
    check(row.kind !== 'stock' || !candidate.order.productId || state.products.some(p => p.id === candidate.order.productId), 'ไม่พบสินค้าเดิมของรายการรอรับ');
    check(row.kind !== 'preorder' || cash(money((candidate.order.internationalShipping || 0) + shares[index])), 'ค่าส่งสะสมเกินขอบเขตที่รองรับ');
    return { ...row, share: shares[index], label: candidate.label, order: candidate.order };
  });
}
export function validateReceivingLots(transactions, preorders) {
  const received = new Map();
  for (const tx of transactions.filter(tx => tx.receivingLot != null)) {
    const lot = tx.receivingLot;
    if (tx.type !== 'expense' || tx.category !== 'ค่าส่งสินค้าเข้า' || !cash(tx.amount) ||
        !lot || typeof lot.name !== 'string' || lot.name.length > 200 || !Array.isArray(lot.items) ||
        lot.items.some(i => !i || !['stock', 'preorder'].includes(i.kind) || typeof i.id !== 'string' ||
          !i.id || typeof i.label !== 'string' || !cash(i.share)) ||
        new Set(lot.items.map(i => i.kind + ':' + i.id)).size !== lot.items.length) return false;
    try {
      const shares = allocateReceiving(tx.amount, lot.mode, lot.items);
      if (shares.some((share, index) => share !== lot.items[index].share)) return false;
    } catch { return false; }
    for (const item of lot.items.filter(i => i.kind === 'preorder')) {
      if (!preorders.some(o => o.id === item.id)) return false;
      const sum = received.get(item.id) || { qty: 0, share: 0 };
      sum.qty += item.qty; sum.share = money(sum.share + item.share);
      received.set(item.id, sum);
    }
  }
  return preorders.every(o => {
    const sum = received.get(o.id);
    return sum ? o.receivedQty === sum.qty && o.internationalShippingRecorded === sum.share :
      o.receivedQty == null && o.internationalShippingRecorded == null;
  });
}
