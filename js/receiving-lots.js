import { money } from './preorders.js';
import { allocateCashCosts, stockOptionKey, stockAdjustment, measurementsOf, measurementLabel } from './inventory-tools.js';

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
        !lot || !['quantity','weight','manual'].includes(lot.mode) || typeof lot.name !== 'string' || lot.name.length > 200 || !Array.isArray(lot.items) ||
        lot.items.some(i => !i || !['stock', 'preorder'].includes(i.kind) || typeof i.id !== 'string' ||
          !i.id || typeof i.label !== 'string' || !cash(i.share)) ||
        new Set(lot.items.map(i => i.kind + ':' + i.id)).size !== lot.items.length) return false;
    try {
      if (lot.items.length === 0) {
        if (lot.cancelled !== true) return false;
        continue;
      }
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

const validUnitCost = value => Number.isFinite(value) && value >= 0 && value <= 1e12;
const normalize = value => String(value || '').trim().replace(/\s+/g,' ').toLowerCase();
const purchaseLabel = (name, option) => [name, option.color, option.size ? 'ไซส์ ' + option.size : '', option.type === 'used' ? 'มือ2' : 'มือ1', measurementLabel(option)].filter(Boolean).join(' · ');

// Recover only an exact order identity or a uniquely linked purchase total/quantity.
// A stock average includes freight and other purchases, so it cannot be a fallback.
export function resolveReceivingPurchase(state, item, binding = null) {
  if (item.kind !== 'stock') return null;
  const variants = state.products.flatMap(product => product.variants.map(variant => ({product, variant})));
  const snapshots = state.transactions.flatMap(tx => [
    ...(tx.purchaseItems || []),
    ...(tx.receivingLot?.items || []).map(row => row.purchase),
    ...(tx.receivingLot?.corrections || []).flatMap(c => c.previousItems || []).map(row => row.purchase)
  ]).filter(order => order?.id === item.id && validUnitCost(order.cost));
  const pending = state.pendingOrders.find(order => order.id === item.id && validUnitCost(order.cost));
  let purchase = item.purchase && validUnitCost(item.purchase.cost) ? item.purchase : pending || snapshots[0];
  const ledger = state.transactions.filter(tx => tx.type === 'expense' && tx.pendingIds?.includes(item.id));
  const single = ledger.length === 1 && ledger[0].pendingIds.length === 1 ? ledger[0] : null;
  const quantityMatch = single?.desc?.match(/\s+x([1-9]\d*)\s*$/);
  const description = quantityMatch ? single.desc.slice(0,quantityMatch.index) : null;
  const labelMatches = variants.filter(({product,variant}) => item.label === `เข้าสต็อก · ${product.name} · ${variant.color || ''} ${variant.size || ''}`);
  let matches = variants.filter(({variant}) => variant.id === (item.variantId || binding?.variantId));
  if (!matches.length && purchase?.name && purchase?.type) matches = variants.filter(({product,variant}) =>
    (purchase.productId ? product.id === purchase.productId : normalize(product.name) === normalize(purchase.name)) && stockOptionKey(variant) === stockOptionKey(purchase));
  if (!matches.length && description) matches = variants.filter(({product,variant}) => normalize(purchaseLabel(product.name,variant)) === normalize(description));
  if (!matches.length) matches = labelMatches;
  if (matches.length !== 1) return purchase ? {purchase} : null;
  const {product,variant} = matches[0];
  if (!purchase && single && quantityMatch && normalize(purchaseLabel(product.name,variant)) === normalize(description)) {
    const originalQty = Number(quantityMatch[1]);
    const cost = single.amount / originalQty;
    if (Number.isSafeInteger(originalQty) && validUnitCost(cost)) purchase = {id:item.id, cost, originalQty, orderDate:single.date, recoveredFrom:single.id};
  }
  if (!purchase && binding?.cost != null && validUnitCost(binding.cost)) purchase = {id:item.id, cost:binding.cost, legacy:true};
  if (!purchase) return {variantId:variant.id};
  return {variantId:variant.id, purchase:{
    name:product.name, productId:product.id, color:variant.color || '', size:variant.size || '', type:variant.type,
    ...measurementsOf(variant), price:variant.price, image:product.image || null, note:'',
    ...purchase, id:item.id, orderDate:purchase.orderDate || single?.date
  }};
}

// Work on a copy so validation errors never leave a partially edited lot.
export function correctReceivingLot(state, data, newId, date, at) {
  const next = JSON.parse(JSON.stringify(state));
  const tx = next.transactions.find(t => t.id === data.id);
  check(tx?.receivingLot && JSON.stringify(tx) === data.expected, 'รายการเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดอีกครั้ง');
  const old = tx.receivingLot.items;
  check(data.quantities.length === old.length, 'รายการรับของไม่ครบ');
  check(cash(data.total) && ['quantity','weight','manual'].includes(data.mode), 'ค่าส่งหรือวิธีแบ่งค่าส่งไม่ถูกต้อง');
  const additions = data.additions || [];
  const items = old.map((item, i) => ({ ...item, ...resolveReceivingPurchase(next, item, data.legacy?.[i]), qty: data.quantities[i] }));
  const rememberedItems = JSON.parse(JSON.stringify(items.map((item,i)=>({...item, qty:old[i].qty}))));
  const candidates = receivingCandidates(next);
  for (const row of additions) {
    const candidate = candidates.find(c => c.kind === row.kind && c.id === row.id);
    check(candidate && row.expected === JSON.stringify(candidate.order), 'รายการรอรับเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดแล้วเลือกใหม่');
    check(Number.isSafeInteger(row.qty) && row.qty > 0 && row.qty <= candidate.remaining, 'จำนวนที่แนบเกินรายการรอรับ');
    check(!items.some(item => item.kind === row.kind && item.id === row.id), 'รายการนี้อยู่ในล็อตแล้ว ให้แก้จำนวนในแถวเดิม');
    const order = candidate.order;
    const item = {kind:row.kind, id:row.id, qty:row.qty, weight:0, share:0, label:candidate.label};
    if (row.kind === 'stock') {
      const normalize = value => (value || '').trim().replace(/\s+/g,' ').toLowerCase();
      let product = order.productId ? next.products.find(p => p.id === order.productId) : next.products.find(p => normalize(p.name) === normalize(order.name));
      check(product || !order.productId, 'ไม่พบสินค้าเดิมของรายการรอรับ');
      if (!product) { product = {id:newId(), name:order.name, image:order.image || null, colorImages:{}, createdAt:date, variants:[]}; next.products.unshift(product); }
      let variant = product.variants.find(v => stockOptionKey(v) === stockOptionKey(order));
      if (!variant) { variant = {id:newId(), color:order.color || '', size:order.size || '', type:order.type, ...measurementsOf(order), qty:0, cost:order.cost, price:order.price, createdAt:date}; product.variants.push(variant); }
      item.variantId = variant.id; item.purchase = JSON.parse(JSON.stringify(order));
    }
    items.push(item);
  }
  check(items.every(item => Number.isSafeInteger(item.qty) && item.qty >= 0), 'จำนวนรับต้องเป็นจำนวนเต็มตั้งแต่ 0');
  const active = items.map((item,i) => ({...item, index:i, share:data.shares?.[i] ?? item.share})).filter(item => item.qty > 0);
  const allocated = active.length ? allocateReceiving(data.total, data.mode, active) : [];
  const shares = items.map(() => 0);
  active.forEach((item,i) => { shares[item.index] = allocated[i]; });
  const changes = new Map();
  items.forEach((item,i) => {
    const previous = old[i];
    const delta = item.qty - (previous?.qty || 0);
    const freightDelta = money(shares[i] - (previous?.share || 0));
    item.share = shares[i];
    if (item.kind === 'preorder') {
      const order = next.preorders.find(o => o.id === item.id);
      check(order, 'ไม่พบพรีออเดอร์เดิม');
      if (delta || freightDelta) {
        check(['ordered','ready'].includes(order.status), 'พรีออเดอร์ที่ส่งมอบหรือยกเลิกแล้วไม่สามารถแก้ล็อตได้');
        check(Number.isSafeInteger((order.receivedQty || 0) + delta) && (order.receivedQty || 0) + delta >= 0 && (order.receivedQty || 0) + delta <= order.qty, 'จำนวนรับพรีออเดอร์เกินจำนวนสั่ง');
        order.receivedQty = (order.receivedQty || 0) + delta;
        order.internationalShipping = money((order.internationalShipping || 0) + freightDelta);
        order.internationalShippingRecorded = money((order.internationalShippingRecorded || 0) + freightDelta);
        check(cash(order.internationalShipping) && cash(order.internationalShippingRecorded), 'ค่าส่งสะสมไม่ถูกต้อง');
        order.status = order.receivedQty === order.qty ? 'ready' : 'ordered'; order.updatedAt = date;
      }
    } else if (delta || freightDelta) {
      if (!item.purchase) {
        const binding = data.legacy?.[i];
        const bound = next.products.flatMap(p => p.variants).find(v => v.id === binding?.variantId || v.id === item.variantId);
        check(bound, 'ล็อตเก่า: เลือกเสื้อรายการนี้ก่อนคืนของ');
        item.variantId = bound.id;
        if (delta) {
          check(binding.cost != null && Number.isFinite(binding.cost) && binding.cost >= 0 && binding.cost <= 1e12, 'ล็อตเก่า: กรอกต้นทุนเดิมก่อนคืนของ ระบบจะจำไว้ให้');
          item.purchase = {id:item.id, cost:binding.cost, legacy:true};
        }
      }
      const variant = next.products.flatMap(p => p.variants).find(v => v.id === item.variantId);
      check(variant && (!delta || item.purchase && Number.isFinite(item.purchase.cost) && item.purchase.cost >= 0 && item.purchase.cost <= 1e12), 'ไม่พบเสื้อหรือต้นทุนเดิม');
      if (delta) {
        const pending = next.pendingOrders.find(o => o.id === item.id);
        if (delta > 0) {
          check(pending && pending.qty >= delta, 'จำนวนรับเพิ่มเกินของที่อยู่ในรอรับ กรุณาแนบรายการรอรับหรือเพิ่มคำสั่งซื้อก่อน');
          pending.originalQty = pending.originalQty ?? pending.qty + (pending.receivedQty || 0);
          pending.qty -= delta; pending.receivedQty = (pending.receivedQty || 0) + delta;
        } else {
          const product = next.products.find(p => p.variants.some(v => v.id === variant.id));
          // The order snapshot contains purchase cost, never the freight-inclusive stock average.
          const restored = {...item.purchase, id:item.id, name:item.purchase.name || product.name,
            productId:product.id, color:item.purchase.color ?? variant.color, size:item.purchase.size ?? variant.size,
            type:item.purchase.type || variant.type, ...measurementsOf(item.purchase),
            cost:item.purchase.cost, price:item.purchase.price ?? variant.price,
            orderDate:item.purchase.orderDate || tx.date, image:item.purchase.image || product.image || null, note:item.purchase.note || ''};
          const receivedElsewhere = next.transactions.filter(t => t.id !== tx.id).flatMap(t => t.receivingLot?.items || []).filter(r => r.kind === 'stock' && r.id === item.id).reduce((sum,r) => sum + r.qty,0);
          if (pending) {
            pending.originalQty = pending.originalQty ?? pending.qty + (pending.receivedQty || 0);
            pending.qty -= delta;
            pending.receivedQty = receivedElsewhere + item.qty;
          } else next.pendingOrders.unshift({...restored, qty:-delta, receivedQty:receivedElsewhere + item.qty, originalQty:receivedElsewhere + (previous?.qty || 0)});
          item.purchase = {...restored, originalQty:pending?.originalQty ?? receivedElsewhere + (previous?.qty || 0)};
        }
      }
      const change = changes.get(variant.id) || {variant, qty:0, value:0};
      change.qty += delta; change.value += delta * (item.purchase?.cost || 0) + freightDelta;
      changes.set(variant.id, change);
    }
  });
  for (const {variant, qty, value} of changes.values()) {
    const actual = variant.qty + qty, totalValue = variant.qty * variant.cost + value;
    check(Number.isSafeInteger(actual) && actual >= 0 && Number.isFinite(totalValue) && totalValue >= -0.001 && (actual !== 0 || Math.abs(totalValue) < 0.001), 'สต็อกหรือต้นทุนคงเหลือไม่พอสำหรับแก้ล็อตนี้ กรุณาตรวจนับสต็อกก่อน');
    if (qty) variant.adjustments = [...(variant.adjustments || []), stockAdjustment(variant, actual, variant.qty, 'แก้ล็อตรับของ ' + tx.id, newId(), at)];
    variant.qty = actual;
    if (actual > 0) variant.cost = Math.max(0,totalValue) / actual;
  }
  next.pendingOrders = next.pendingOrders.filter(order => order.qty > 0);
  tx.receivingLot.corrections = [...(tx.receivingLot.corrections || []), {at, previousAmount:tx.amount, previousItems:rememberedItems}];
  tx.amount = data.total; tx.receivingLot.mode = data.mode; tx.receivingLot.items = items.filter(item => item.qty > 0);
  tx.receivingLot.cancelled = tx.receivingLot.items.length === 0;
  for (const order of next.preorders) {
    if (order.receivedQty === 0 && !next.transactions.some(t => t.receivingLot?.items.some(item => item.kind === 'preorder' && item.id === order.id))) {
      delete order.receivedQty; delete order.internationalShippingRecorded;
    }
  }
  check(validateReceivingLots(next.transactions, next.preorders), 'ข้อมูลล็อตรับของไม่ถูกต้อง');
  return next;
}
