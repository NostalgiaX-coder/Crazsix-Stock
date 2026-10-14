// Inventory invariants are checked before any in-memory mutation.
export const measurementFields = ['chestInches', 'lengthInches'];
export const parseMeasurement = value => value == null || String(value).trim() === '' ? null : Number(value);
export const measurementsOf = row => Object.fromEntries(measurementFields.map(key => [key, row[key] ?? null]));
export const validMeasurements = row => measurementFields.every(key => row[key] == null ||
  (Number.isFinite(row[key]) && row[key] > 0 && row[key] <= 300 && Math.abs(row[key] * 100 - Math.round(row[key] * 100)) < .000001));
export const measurementLabel = row => [row.chestInches != null ? `อก ${row.chestInches} นิ้ว` : '', row.lengthInches != null ? `ยาว ${row.lengthInches} นิ้ว` : ''].filter(Boolean).join(' · ');
export function stockOptionKey(row) {
  const normalize = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return JSON.stringify([normalize(row.color), normalize(row.size), row.type, row.chestInches ?? null, row.lengthInches ?? null]);
}
const normalizeStockText = value => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
const stockTagKey = row => stockOptionKey({ ...row, chestInches: null, lengthInches: null });

// An unknown measurement can use a known new-stock option only when it is unambiguous.
export function matchingStockOption(variants, row) {
  const exact = variants.find(v => stockOptionKey(v) === stockOptionKey(row));
  if (exact) return exact;
  if (row.type !== 'new' || row.chestInches != null || row.lengthInches != null) return null;
  const candidates = variants.filter(v => v.type === 'new' && stockTagKey(v) === stockTagKey(row) &&
    v.chestInches != null && v.lengthInches != null);
  return candidates.length && new Set(candidates.map(stockOptionKey)).size === 1 ? candidates[0] : null;
}

// Normalize a copy so all screens and mutations use one real stock balance.
// Aliases let old sales and receipt references resolve after a later realtime update.
export function combineUnmeasuredStock(state) {
  const next = JSON.parse(JSON.stringify(state));
  const groups = new Map();
  for (const product of next.products) {
    for (const variant of product.variants) {
      if (variant.type !== 'new') continue;
      const key = JSON.stringify([normalizeStockText(product.name), stockTagKey(variant)]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ product, variant });
    }
  }
  for (const entries of groups.values()) {
    const known = entries.filter(({variant:v}) => v.chestInches != null && v.lengthInches != null);
    if (!known.length || new Set(known.map(({variant}) => stockOptionKey(variant))).size !== 1) continue;
    const target = known[0].variant;
    for (const {product, variant:source} of entries) {
      if (source.chestInches != null || source.lengthInches != null) continue;
      const qty = target.qty + source.qty;
      if (!Number.isSafeInteger(qty) || qty < 0) continue;
      target.cost = qty > 0 ? (target.qty * target.cost + source.qty * source.cost) / qty : target.cost;
      target.qty = qty;
      target.stockAliases = [...new Set([...(target.stockAliases || []), source.id, ...(source.stockAliases || [])])];
      if (source.adjustments?.length) target.adjustments = [...(target.adjustments || []), ...source.adjustments].sort((a,b) => a.date.localeCompare(b.date));
      product.variants = product.variants.filter(v => v !== source);
    }
  }
  const aliases = new Map(next.products.flatMap(p => p.variants).flatMap(v => (v.stockAliases || []).map(id => [id, v.id])));
  const canonical = id => aliases.get(id) || id;
  for (const tx of next.transactions || []) {
    if (tx.productId != null) tx.productId = canonical(tx.productId);
    for (const item of tx.items || []) if (item.productId != null) item.productId = canonical(item.productId);
    for (const item of tx.receivingLot?.items || []) if (item.variantId) item.variantId = canonical(item.variantId);
  }
  for (const order of next.preorders || []) if (order.fulfillment?.variantId) order.fulfillment.variantId = canonical(order.fulfillment.variantId);
  return next;
}
export function assertStockRows(rows, existing = null) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('กรุณาระบุรายการสินค้าอย่างน้อย 1 รายการ');
  const ids = new Set();
  for (const [index, row] of rows.entries()) {
    if (!validMeasurements(row)) throw new Error(`อกและความยาวต้องมากกว่า 0 ไม่เกิน 300 นิ้ว ทศนิยมไม่เกิน 2 ตำแหน่ง หรือเว้นว่าง (แถว ${index + 1})`);
    if (!Number.isSafeInteger(row.qty) || row.qty < 1 ||
        !Number.isFinite(row.cost) || row.cost < 0 || row.cost > 1e12 ||
        !Number.isFinite(row.cost * row.qty) || row.cost * row.qty > 1e12 ||
        (row.price != null && (!Number.isFinite(row.price) || row.price < 0 || row.price > 1e12)))
      throw new Error(`จำนวนต้องเป็นจำนวนเต็มมากกว่า 0 และต้นทุน/ราคาต้องถูกต้อง (แถว ${index + 1})`);
    if (existing) {
      if (!existing.has(row.variantId) || ids.has(row.variantId)) throw new Error('พบสินค้าที่ถูกลบหรือเลือกซ้ำ กรุณาเลือกสินค้าล่าสุดอีกครั้ง');
      ids.add(row.variantId);
      if (!Number.isSafeInteger(existing.get(row.variantId).qty + row.qty)) throw new Error('จำนวนรวมมากเกินกว่าระบบรองรับ');
    } else if (typeof row.name !== 'string' || !row.name.trim() || !['new', 'used'].includes(row.type) || row.price == null) {
      throw new Error(`กรุณาระบุชื่อ สภาพ และราคาสินค้า (แถว ${index + 1})`);
    }
  }
}
export function assertShipping(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1e12 || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001)
    throw new Error('ค่าส่งต้องเป็นจำนวนตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
}
export function stockAdjustment(variant, actual, expected, reason, id, date) {
  if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('จำนวนที่นับได้ต้องเป็นจำนวนเต็มตั้งแต่ 0');
  if (variant.qty !== expected) throw new Error('จำนวนสต็อกเปลี่ยนระหว่างตรวจนับ กรุณาเลือกสินค้าใหม่แล้วตรวจสอบอีกครั้ง');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new Error('กรุณาระบุเหตุผลไม่เกิน 500 ตัวอักษร');
  if (actual === expected) throw new Error('จำนวนตรงกับสต็อกแล้ว ไม่ต้องปรับยอด');
  return { id, date, before: expected, after: actual, delta: actual - expected, reason: reason.trim() };
}
export function validAdjustments(rows) {
  return rows == null || (Array.isArray(rows) && rows.every(row => row &&
    typeof row.id === 'string' && typeof row.reason === 'string' && row.reason.trim() && row.reason.length <= 500 &&
    typeof row.date === 'string' && !Number.isNaN(Date.parse(row.date)) &&
    Number.isSafeInteger(row.before) && Number.isSafeInteger(row.after) && row.after >= 0 && row.delta === row.after - row.before));
}

// Allocate a batch's cash cost to the cent; keep inventory unit costs unrounded.
export function allocateCashCosts(values) {
  const scaled = values.map(value => value * 100);
  const cents = scaled.map(value => Math.floor(value));
  let remaining = Math.round(values.reduce((sum, value) => sum + value, 0) * 100) - cents.reduce((sum, value) => sum + value, 0);
  const rank = scaled.map((value, index) => ({ index, fraction: value - cents[index] })).sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of rank) {
    if (remaining <= 0) break;
    cents[index]++; remaining--;
  }
  return cents.map(value => value / 100);
}
