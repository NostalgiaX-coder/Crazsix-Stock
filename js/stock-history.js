import { allocateCashCosts, assertShipping } from './inventory-tools.js';
const clone = value => JSON.parse(JSON.stringify(value));
const comparable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const validItems = items => Array.isArray(items) && items.length > 0 && items.every(item => item && typeof item.variantId === 'string' && typeof item.label === 'string' && Number.isSafeInteger(item.qty) && item.qty > 0 && [item.cost,item.price].every(v => Number.isFinite(v) && v >= 0 && v <= 1e12) && item.cost * item.qty <= 1e12);
export function validStockHistory(history) {
  if (history == null) return true;
  return Array.isArray(history) && history.every(batch => batch && typeof batch.id === 'string' && ['new','restock'].includes(batch.kind) && validDate(batch.date) && typeof batch.createdAt === 'string' && Number.isFinite(Date.parse(batch.createdAt)) && typeof batch.logExpense === 'boolean' && Number.isFinite(batch.shipping) && batch.shipping >= 0 && batch.shipping <= 1e12 && validItems(batch.items) && Array.isArray(batch.expenseIds) && batch.expenseIds.every(id => typeof id === 'string') && (batch.shippingId == null || typeof batch.shippingId === 'string') && Array.isArray(batch.accounting) && batch.accounting.every(tx => tx && typeof tx.id === 'string' && Number.isFinite(tx.amount) && tx.amount >= 0) && Array.isArray(batch.edits) && batch.edits.every(edit => edit && typeof edit.date === 'string' && [edit.before,edit.after].every(version => version && validDate(version.date) && Number.isFinite(version.shipping) && version.shipping >= 0 && validItems(version.items))));
}

export const stockBatches = state => state.products.flatMap(product => product.stockHistory || []).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
const find = (state, id) => state.products.flatMap(p => p.variants).find(v => v.id === id || v.stockAliases?.includes(id));

export function recordStockBatch(state, rows, base, kind, previousIds, id, date) {
  const batch = {id, kind, date, createdAt: new Date().toISOString(), logExpense: !!base.logExpense, shipping: Number(base.shippingIn || 0), items: rows.map(row => ({variantId: row.variant.id, label: row.label, qty: row.qty, cost: row.cost, price: row.variant.price})), edits: []};
  const added = state.transactions.filter(tx => !previousIds.has(tx.id));
  batch.expenseIds = added.filter(tx => tx.category !== 'ค่าส่งสินค้าเข้า').map(tx => tx.id);
  batch.shippingId = added.find(tx => tx.category === 'ค่าส่งสินค้าเข้า')?.id || null;
  batch.accounting = clone(added);
  const owner = state.products.find(p => p.variants.some(v => v.id === rows[0].variant.id));
  owner.stockHistory = [batch, ...(owner.stockHistory || [])];
}

export function correctStockBatch(state, data, uid, now) {
  const next = clone(state), batch = stockBatches(next).find(b => b.id === data.id);
  if (!batch || JSON.stringify(batch) !== data.expected) throw new Error('ประวัติเปลี่ยนแปลง กรุณาเปิดรายการล่าสุดอีกครั้ง');
  if (!validDate(data.date)) throw new Error('วันที่ไม่ถูกต้อง');
  assertShipping(data.shipping);
  if (data.items.length !== batch.items.length) throw new Error('รายการสินค้าไม่ครบ');
  const before = clone(batch);
  if (batch.accounting.some(stored => {
    const expected = {...stored};
    if (expected.productId) expected.productId = find(next,expected.productId)?.id || expected.productId;
    return comparable(next.transactions.find(tx => tx.id === stored.id)) !== comparable(expected);
  })) throw new Error('รายการบัญชีของล็อตนี้ถูกแก้ไข กรุณาตรวจสอบก่อนแก้ประวัติสต็อก');
  const costs = allocateCashCosts(data.items.map(item => item.qty * item.cost));
  // Work on a copy: no stock or accounting changes escape a rejected correction.
  batch.items.forEach((old, index) => {
    const item = data.items[index], variant = find(next, old.variantId);
    if (!variant) throw new Error('สินค้าถูกลบแล้ว ไม่สามารถแก้ไขล็อตนี้ได้');
    if (!Number.isSafeInteger(item.qty) || item.qty < 1 || ![item.cost,item.price].every(v => Number.isFinite(v) && v >= 0 && v <= 1e12) || item.qty * item.cost > 1e12) throw new Error('ระบุจำนวนเต็มมากกว่า 0 และต้นทุน/ราคาให้ถูกต้อง');
    if (item.cost !== old.cost && variant.qty < old.qty) throw new Error('สินค้าล็อตนี้ถูกใช้ไปบางส่วนแล้ว ไม่สามารถแก้ต้นทุนทั้งล็อตได้');
    const qty = variant.qty + item.qty - old.qty;
    if (!Number.isSafeInteger(qty) || qty < 0) throw new Error('ลดจำนวนไม่ได้ เพราะสินค้าบางส่วนถูกขายหรือใช้ไปแล้ว');
    const value = variant.qty * variant.cost + item.qty * item.cost - old.qty * old.cost;
    if ((item.cost !== old.cost || item.qty !== old.qty) && (value < -0.000001 || (qty === 0 && Math.abs(value) > 0.000001))) throw new Error('ต้นทุนที่แก้ไขขัดกับสต็อกที่เหลือ กรุณาตรวจรายการขายและล็อตที่เกี่ยวข้อง');
    variant.qty = qty;
    if (qty > 0) variant.cost = Math.max(0, value) / qty;
    if (item.price !== old.price) variant.price = item.price;
    Object.assign(old, item);
  });
  const expenses = next.transactions.filter(tx => batch.expenseIds.includes(tx.id));
  if (expenses.length !== batch.expenseIds.length || expenses.some(tx => tx.type !== 'expense') || (batch.shippingId && !next.transactions.some(tx => tx.id === batch.shippingId && tx.type === 'expense'))) throw new Error('รายการบัญชีที่ผูกไว้ถูกลบหรือเปลี่ยน กรุณาตรวจสอบก่อน');
  const ids = new Set(batch.expenseIds);
  next.transactions = next.transactions.filter(tx => !ids.has(tx.id));
  batch.expenseIds = [];
  if (batch.logExpense) batch.items.forEach((item,index) => {
    if (!costs[index]) return;
    const txId = before.expenseIds[index] || uid();
    batch.expenseIds.push(txId);
    next.transactions.unshift({id:txId,type:'expense',category:batch.kind === 'restock' ? 'เติมสต๊อกสินค้าเดิม' : 'ซื้อสินค้าเข้าสต็อก',desc:item.label + ' x' + item.qty,productId:find(next,item.variantId).id,amount:costs[index],date:data.date});
  });
  if (batch.shippingId) next.transactions = next.transactions.filter(tx => tx.id !== batch.shippingId);
  if (data.shipping > 0) {
    batch.shippingId ||= uid();
    next.transactions.unshift({id:batch.shippingId,type:'expense',category:'ค่าส่งสินค้าเข้า',desc:batch.items.map(item => item.label).join(', ') + ' (ค่าส่งจากต้นทาง)',amount:data.shipping,date:data.date,productId:null});
  } else batch.shippingId = null;
  const accountingIds = new Set([...batch.expenseIds, batch.shippingId].filter(Boolean));
  batch.accounting = clone(next.transactions.filter(tx => accountingIds.has(tx.id)));
  batch.date = data.date; batch.shipping = data.shipping;
  batch.edits.push({date:now, before:{date:before.date,shipping:before.shipping,items:before.items},after:{date:batch.date,shipping:batch.shipping,items:clone(batch.items)}});
  return next;
}

export function renderStockHistory(state, {esc, fmt}) {
  const batches = stockBatches(state);
  const linked = new Set(batches.flatMap(batch => [...batch.expenseIds, batch.shippingId].filter(Boolean)));
  const legacy = state.transactions.filter(tx => !linked.has(tx.id) && ['ซื้อสินค้าเข้าสต็อก','เติมสต๊อกสินค้าเดิม'].includes(tx.category));
  return `<section id="stock-entry-history"><h3>ประวัติการเพิ่ม / เติมสต็อก</h3><p class="hint">เปิดรายการเพื่อแก้จำนวนที่นำเข้า ต้นทุน ราคาขาย วันที่ และค่าส่ง ระบบปรับยอดคงเหลือและรายจ่ายที่ผูกไว้พร้อมกัน ประวัติการขายเดิมยังใช้ต้นทุน ณ วันที่ขาย</p>${batches.map(batch => `<details class="receipt-lot" data-stock-batch="${esc(batch.id)}"><summary>${esc(batch.date)} · ${batch.kind === 'restock' ? 'เติมสต็อก' : 'เพิ่มสินค้า'} · ${esc(batch.items[0].label)}<small>${batch.items.reduce((sum,item)=>sum+item.qty,0)} ชิ้น · ต้นทุน ${fmt(batch.items.reduce((sum,item)=>sum+item.qty*item.cost,0))} · ค่าส่ง ${fmt(batch.shipping)}${batch.logExpense ? '' : ' · ไม่บันทึกรายจ่ายสินค้า'}</small></summary><form data-stock-history-edit="${esc(batch.id)}" data-expected="${esc(JSON.stringify(batch))}"><div class="field"><label>วันที่ทำรายการ</label><input name="date" type="date" value="${esc(batch.date)}" required></div>${batch.items.map((item,index) => `<div class="receipt-existing-row" data-history-item="${index}"><strong>${esc(item.label)}</strong><button type="button" class="btn btn-ghost btn-sm" data-history-variant="${esc(item.variantId)}">แก้ไขรายละเอียดสินค้า</button><div class="form-grid"><div class="field"><label>จำนวนที่นำเข้า (ชิ้น)</label><input name="qty" type="number" min="1" step="1" value="${item.qty}" required></div><div class="field"><label>ต้นทุน/ชิ้น</label><input name="cost" type="number" min="0" step="any" value="${item.cost}" required></div><div class="field"><label>ราคาขาย (โน้ต)</label><input name="price" type="number" min="0" step="any" value="${item.price}" required></div></div></div>`).join('')}<div class="field"><label>ค่าส่งรวม (บาท)</label><input name="shipping" type="number" min="0" step="0.01" value="${batch.shipping}" required></div><button type="submit" class="btn btn-primary">บันทึกการแก้ไข</button></form>${batch.edits.length ? `<details><summary>ประวัติแก้ไข (${batch.edits.length})</summary>${batch.edits.map(edit => `<p>${esc(edit.date)} · ${edit.before.items.map(item=>`${esc(item.label)} ${item.qty} ชิ้น × ${fmt(item.cost)}`).join(', ')} → ${edit.after.items.map(item=>`${item.qty} ชิ้น × ${fmt(item.cost)}`).join(', ')} · ค่าส่ง ${fmt(edit.before.shipping)} → ${fmt(edit.after.shipping)}</p>`).join('')}</details>` : ''}</details>`).join('')}${legacy.length ? `<details><summary>รายการเก่าก่อนมีประวัติละเอียด (${legacy.length})</summary><p class="hint">รายการเก่าไม่มีจำนวนและต้นทุนต่อครั้งครบถ้วน เปิดแก้รายละเอียดสินค้าและยอดคงเหลือปัจจุบันได้</p>${legacy.map(tx => `<p>${esc(tx.date)} · ${esc(tx.desc)} · ${fmt(tx.amount)} ${find(state,tx.productId) ? `<button type="button" class="btn btn-ghost btn-sm" data-history-variant="${esc(tx.productId)}">แก้ไขสินค้า</button>` : ''}</p>`).join('')}</details>` : ''}${!batches.length && !legacy.length ? '<p class="hint">ยังไม่มีประวัติการเพิ่ม / เติมสต็อก</p>' : ''}<button type="button" class="btn btn-ghost" data-history-workspace="history">ดู / แก้ไขประวัติรับของ</button><button type="button" class="btn btn-ghost" data-history-workspace="pending">ดูรายการสั่งซื้อรอรับ</button></section>`;
}
