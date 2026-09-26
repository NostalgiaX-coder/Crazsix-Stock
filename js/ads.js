// Campaign planning and cost attribution. Inventory purchase costs are never rewritten.
import { money } from './preorders.js';

export const adStatuses = { draft: 'ร่าง', active: 'เปิดใช้งาน', paused: 'พัก', completed: 'จบแคมเปญ', cancelled: 'ยกเลิก' };
export const isAdSale = tx => tx.category === 'ขายสินค้า' && ['income', 'installment', 'preorder'].includes(tx.type) && Number.isFinite(tx.profit);
export const isAdSpend = tx => tx.type === 'expense' && tx.category === 'ค่าโฆษณาสินค้า' && Boolean(tx.adCampaignId);
const cash = value => Number.isFinite(value) && value >= 0 && value <= 1e12 && Math.abs(value * 100 - Math.round(value * 100)) < .001;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const textValid = (v, max, required = false) => typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0);
export const safeAdUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
export const campaignProductIds = c => Array.isArray(c?.productIds) ? c.productIds : c?.productId ? [c.productId] : [];
export const campaignHasProduct = (c, id) => campaignProductIds(c).includes(id);
export const campaignUntilBudget = c => c.runMode === 'until_budget';
export function allocateAdSpend(amount, ids) {
  const sorted = [...ids].sort();
  const cents = Math.round(amount * 100), base = Math.floor(cents / sorted.length), remainder = cents % sorted.length;
  return sorted.map((productId, index) => ({productId, amount: (base + (index < remainder ? 1 : 0)) / 100}));
}
export const adSpendAllocations = (tx, c) => tx.adAllocations || allocateAdSpend(tx.amount, campaignProductIds(c));
export function validateAdCampaign(c) {
  return c && textValid(c.id, 100, true) && !/[\s<>"'&]/.test(c.id) && textValid(c.productId, 100, true) &&
    (c.productIds == null || (Array.isArray(c.productIds) && c.productIds.length > 0 && c.productIds[0] === c.productId && new Set(c.productIds).size === c.productIds.length && c.productIds.every(id => textValid(id, 100, true)))) &&
    textValid(c.name, 120, true) && textValid(c.channel, 80, true) && Object.hasOwn(adStatuses, c.status) &&
    dateValid(c.startDate) && (c.runMode == null || ['dated', 'until_budget'].includes(c.runMode)) &&
    (campaignUntilBudget(c) ? c.endDate === '' : dateValid(c.endDate) && c.endDate >= c.startDate) && cash(c.budget) &&
    Number.isSafeInteger(c.targetQty) && c.targetQty > 0 && c.targetQty <= 1e9 &&
    Number.isFinite(c.reservePercent) && c.reservePercent >= 0 && c.reservePercent <= 100 &&
    textValid(c.note, 2000) && textValid(c.url, 2000) && (!c.url || Boolean(safeAdUrl(c.url)));
}
export function campaignPhase(c, today, transactions = []) {
  if (c.status !== 'active') return c.status;
  if (today < c.startDate) return 'scheduled';
  if (campaignUntilBudget(c)) {
    const spent = money(transactions.filter(tx => tx.adCampaignId === c.id && isAdSpend(tx)).reduce((sum, tx) => sum + tx.amount, 0));
    if (spent >= c.budget) return 'exhausted';
  } else if (today > c.endDate) return 'ended';
  return 'active';
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
export function adMetrics(c, transactions, today) {
  const sales = transactions.filter(tx => tx.adCampaignId === c.id && isAdSale(tx));
  const expenses = transactions.filter(tx => tx.adCampaignId === c.id && isAdSpend(tx));
  const sum = (rows, key) => money(rows.reduce((s, r) => s + r[key], 0));
  const spend = sum(expenses, 'amount'), revenue = sum(sales, 'amount'), grossProfit = sum(sales, 'profit');
  const qty = sales.reduce((s, r) => s + r.qty, 0);
  // For installments, subtract the entire sale cost before reserving any received cash.
  const cashMargin = money(sales.reduce((s, r) => s + r.profit - (r.type === 'installment' ? Math.max(0, r.amount - (r.paidAmount || 0)) : 0), 0));
  const net = money(grossProfit - spend), cashNet = money(cashMargin - spend);
  const reserve = money(Math.max(0, cashNet) * c.reservePercent / 100);
  const days = campaignUntilBudget(c) ? null : daysBetween(c.startDate, c.endDate), daysLeft = days == null ? null : Math.max(0, daysBetween(today < c.startDate ? c.startDate : today, c.endDate));
  return { sales, expenses, spend, revenue, qty, grossProfit, net, cashNet, reserve, days, daysLeft,
    remaining: money(c.budget - spend), plannedPerUnit: c.budget / c.targetQty,
    actualPerUnit: qty ? spend / qty : null, daily: days == null ? null : c.budget / days,
    roas: spend ? revenue / spend : null, reservePerUnit: qty ? reserve / qty : 0,
  };
}
export function saleMatchesProduct(tx, product) {
  return Boolean(product) && isAdSale(tx) && (tx.stockProductId ? tx.stockProductId === product.id : product.variants.some(v => v.id === tx.productId));
}
export function productAdMetrics(product, campaigns, transactions, today) {
  const linked = campaigns.filter(c => campaignHasProduct(c, product.id));
  const sales = transactions.filter(tx => isAdSale(tx) && saleMatchesProduct(tx, product));
  const spend = money(linked.reduce((sum, c) => sum + transactions.filter(tx => isAdSpend(tx) && tx.adCampaignId === c.id).reduce((total, tx) => total + (adSpendAllocations(tx, c).find(a => a.productId === product.id)?.amount || 0), 0), 0));
  const profit = money(sales.reduce((s, tx) => s + tx.profit, 0));
  const plannedPerUnit = linked.filter(c => ['active', 'scheduled'].includes(campaignPhase(c, today, transactions))).reduce((s, c) => s + c.budget / c.targetQty, 0);
  return { linked, spend, profit, net: money(profit - spend), plannedPerUnit };
}
export function validateAdsBackup(campaigns, transactions, products) {
  if (!Array.isArray(campaigns) || !campaigns.every(validateAdCampaign) || new Set(campaigns.map(c => c.id)).size !== campaigns.length || campaigns.some(c => campaignProductIds(c).some(id => !products.some(p => p.id === id)))) return false;
  return transactions.every(tx => {
    if (!tx.adCampaignId) return tx.adCampaignId == null && tx.adAllocations == null;
    const c = campaigns.find(c => c.id === tx.adCampaignId);
    if (!c) return false;
    if (isAdSpend(tx)) {
      const a = tx.adAllocations;
      return cash(tx.amount) && tx.amount > 0 && (a == null ? campaignProductIds(c).length === 1 : Array.isArray(a) && a.length > 0 &&
        new Set(a.map(row => row?.productId)).size === a.length && a.every(row => row && campaignHasProduct(c, row.productId) && cash(row.amount)) &&
        Math.abs(a.reduce((sum,row) => sum + row.amount, 0) - tx.amount) < .001);
    }
    return isAdSale(tx) && products.some(p => campaignHasProduct(c,p.id) && saleMatchesProduct(tx,p)) && cash(tx.amount) && Number.isSafeInteger(tx.qty) && tx.qty > 0;
  });
}

// Returns new arrays only after all validations pass; caller commits them atomically.
export function applyAdAction(state, action, id, today) {
  let campaigns = structuredClone(state.adCampaigns), transactions = structuredClone(state.transactions);
  const campaign = campaigns.find(c => c.id === action.campaignId);
  if (action.type !== 'create' && (!campaign || JSON.stringify(campaign) !== action.expected)) throw new Error('แคมเปญเปลี่ยนแปลง กรุณาเปิดรายการล่าสุดแล้วลองอีกครั้ง');
  const selectedIds = campaignProductIds(action.type === 'create' ? action.values : campaign);
  const selectedProducts = state.products.filter(p => selectedIds.includes(p.id));
  if (!selectedIds.length || selectedProducts.length !== selectedIds.length) throw new Error('ไม่พบสินค้าที่ผูกกับแคมเปญ');
  if (['create', 'edit'].includes(action.type)) {
    const next = { ...action.values, id: campaign?.id || id };
    if (!validateAdCampaign(next) || campaignProductIds(next).some(id => !state.products.some(p => p.id === id))) throw new Error('กรุณาตรวจชื่อสินค้า งบ จำนวนเป้าหมาย วันที่ และสัดส่วนเก็บกำไร 0–100%');
    if (campaign) {
      const removed = selectedProducts.filter(p => !campaignHasProduct(next,p.id));
      if (removed.some(p => transactions.some(tx => tx.adCampaignId === campaign.id &&
        ((isAdSpend(tx) && adSpendAllocations(tx,campaign).some(a => a.productId === p.id)) || saleMatchesProduct(tx,p)))))
        throw new Error('สินค้าที่มีต้นทุนหรือยอดขายผูกอยู่แล้วไม่สามารถนำออกได้ แต่เพิ่มสินค้าอื่นได้');
      // Freeze historical shares before adding products, including old single-product campaigns.
      transactions.filter(tx => tx.adCampaignId === campaign.id && isAdSpend(tx) && !tx.adAllocations).forEach(tx => { tx.adAllocations = adSpendAllocations(tx,campaign); });
    }
    campaigns = campaign ? campaigns.map(c => c.id === campaign.id ? next : c) : [next, ...campaigns];
  } else if (action.type === 'spend') {
    if (!cash(action.amount) || action.amount <= 0 || !dateValid(action.date) || action.date > today || !textValid(action.note, 500)) throw new Error('ระบุค่าแอดที่จ่ายจริงมากกว่า 0 และวันที่จ่ายไม่เกินวันนี้');
    transactions.unshift({ id, adCampaignId: campaign.id, type: 'expense', category: 'ค่าโฆษณาสินค้า', amount: action.amount, date: action.date, adAllocations: allocateAdSpend(action.amount, selectedIds), desc: `${campaign.name} · ${selectedProducts.map(p => p.name).join(', ')}${action.note ? ' · ' + action.note : ''}` });
  } else if (['link', 'unlink', 'removeSpend'].includes(action.type)) {
    const tx = transactions.find(t => t.id === action.transactionId);
    if (!tx || JSON.stringify(tx) !== action.expectedTransaction) throw new Error('รายการบัญชีเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุด');
    if (action.type === 'link') {
      const product = selectedProducts.find(p => saleMatchesProduct(tx,p));
      if (!product || tx.adCampaignId) throw new Error('เลือกยอดขายของสินค้านี้ที่ยังไม่ผูกกับแคมเปญอื่น');
      tx.adCampaignId = campaign.id;
      tx.stockProductId = product.id;
    } else {
      if (tx.adCampaignId !== campaign.id) throw new Error('รายการนี้ไม่ได้ผูกกับแคมเปญ');
      if (action.type === 'removeSpend') {
        if (!isAdSpend(tx)) throw new Error('รายการนี้ไม่ใช่ค่าแอด');
        transactions = transactions.filter(t => t.id !== tx.id);
      } else {
        if (!isAdSale(tx)) throw new Error('รายการนี้ไม่ใช่ยอดขาย');
        delete tx.adCampaignId;
      }
    }
  } else if (action.type === 'delete') {
    if (transactions.some(tx => tx.adCampaignId === campaign.id)) throw new Error('แคมเปญมีค่าใช้จ่ายหรือยอดขายแล้ว ให้เปลี่ยนสถานะเป็นจบแคมเปญเพื่อเก็บประวัติ');
    campaigns = campaigns.filter(c => c.id !== campaign.id);
  } else throw new Error('ไม่รองรับคำสั่งนี้');
  return { adCampaigns: campaigns, transactions };
}
