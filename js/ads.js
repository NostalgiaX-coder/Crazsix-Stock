// Campaign planning and cost attribution. Inventory purchase costs are never rewritten.
import { money } from './preorders.js';

export const adStatuses = { draft: 'ร่าง', active: 'เปิดใช้งาน', paused: 'พัก', completed: 'จบแคมเปญ', cancelled: 'ยกเลิก' };
export const isAdSale = tx => tx.category === 'ขายสินค้า' && ['income', 'installment', 'preorder'].includes(tx.type) && Number.isFinite(tx.profit);
export const isAdSpend = tx => tx.type === 'expense' && tx.category === 'ค่าโฆษณาสินค้า' && Boolean(tx.adCampaignId);
const cash = value => Number.isFinite(value) && value >= 0 && value <= 1e12 && Math.abs(value * 100 - Math.round(value * 100)) < .001;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const textValid = (v, max, required = false) => typeof v === 'string' && v.length <= max && (!required || v.trim().length > 0);
export function validateAdWallet(entries, campaigns = []) {
  return Array.isArray(campaigns) && Array.isArray(entries) && entries.every(e => e && textValid(e.id,100,true) && !/[\s<>"'&]/.test(e.id) && cash(e.amount) && e.amount > 0 && dateValid(e.date) && textValid(e.note,500) &&
    (e.campaignId == null ? e.budgetIncrease == null : campaigns.some(c=>c.id===e.campaignId) && (e.budgetIncrease == null || e.budgetIncrease === e.amount))) &&
    new Set(entries.map(e => e.id)).size === entries.length && cash(money(entries.reduce((sum,e) => sum + e.amount,0)));
}
export function adWalletMetrics(entries, transactions) {
  const toppedUp = money(entries.reduce((sum,e) => sum + e.amount,0));
  const spent = money(transactions.filter(tx => isAdSpend(tx) && tx.adWalletFunded === true).reduce((sum,tx) => sum + tx.amount,0));
  return { toppedUp, spent, balance: money(toppedUp - spent) };
}
export function dailyAdSpend(campaignId, transactions) {
  const days = new Map();
  for (const tx of transactions.filter(tx => isAdSpend(tx) && tx.adCampaignId === campaignId)) {
    const row = days.get(tx.date) || {date:tx.date, amount:0, wallet:0, direct:0, count:0};
    row.amount = money(row.amount + tx.amount);
    const source = tx.adWalletFunded ? 'wallet' : 'direct';
    row[source] = money(row[source] + tx.amount); row.count++;
    days.set(tx.date,row);
  }
  return [...days.values()].sort((a,b) => b.date.localeCompare(a.date));
}
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
  return c && validAutoHistory(c) && textValid(c.id, 100, true) && !/[\s<>"'&]/.test(c.id) && textValid(c.productId, 100, true) &&
    (c.productIds == null || (Array.isArray(c.productIds) && c.productIds.length > 0 && c.productIds[0] === c.productId && new Set(c.productIds).size === c.productIds.length && c.productIds.every(id => textValid(id, 100, true)))) &&
    textValid(c.name, 120, true) && textValid(c.channel, 80, true) && Object.hasOwn(adStatuses, c.status) &&
    dateValid(c.startDate) && (c.runMode == null || ['dated', 'until_budget'].includes(c.runMode)) &&
    (campaignUntilBudget(c) ? c.endDate === '' : dateValid(c.endDate) && c.endDate >= c.startDate) && (c.budget == null || cash(c.budget)) &&
    (c.dailyBudget == null || (cash(c.dailyBudget) && c.dailyBudget > 0)) &&
    Number.isSafeInteger(c.targetQty) && c.targetQty > 0 && c.targetQty <= 1e9 &&
    (c.reservePerUnit == null || cash(c.reservePerUnit)) &&
    Number.isFinite(c.reservePercent) && c.reservePercent >= 0 && c.reservePercent <= 100 &&
    textValid(c.note, 2000) && textValid(c.url, 2000) && (!c.url || Boolean(safeAdUrl(c.url)));
}
export function campaignPhase(c, today, transactions = [], wallet = []) {
  if (c.status !== 'active') return c.status;
  if (today < c.startDate) return 'scheduled';
  if (!campaignUntilBudget(c) && today > c.endDate) return 'ended';
  if (adWalletMetrics(wallet, transactions).balance <= 0) return 'exhausted';
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
  const fixedReserve = money(sales.reduce((sum, tx) => sum + (tx.adReservePerUnit ?? c.reservePerUnit ?? 0) * tx.qty, 0));
  const percentReserve = c.reservePerUnit == null ? money(Math.max(0, cashNet) * c.reservePercent / 100 * (qty ? sales.filter(tx => tx.adReservePerUnit == null).reduce((sum, tx) => sum + tx.qty, 0) / qty : 0)) : 0;
  const reserve = money(fixedReserve + percentReserve);
  const days = campaignUntilBudget(c) ? null : daysBetween(c.startDate, c.endDate), daysLeft = days == null ? null : Math.max(0, daysBetween(today < c.startDate ? c.startDate : today, c.endDate));
  return { sales, expenses, spend, revenue, qty, grossProfit, net, cashNet, reserve, fixedReserve, percentReserve, days, daysLeft,
    spentToday: sum(expenses.filter(tx => tx.date === today), 'amount'),
    actualPerUnit: qty ? spend / qty : null,
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
  return { linked, spend, profit, net: money(profit - spend) };
}
export function validateAdsBackup(campaigns, transactions, products) {
  if (!Array.isArray(campaigns) || !campaigns.every(validateAdCampaign) || new Set(campaigns.map(c => c.id)).size !== campaigns.length || campaigns.some(c => campaignProductIds(c).some(id => !products.some(p => p.id === id)))) return false;
  return transactions.every(tx => {
    if (tx.adReservePerUnit != null && (!cash(tx.adReservePerUnit) || !cash(money(tx.adReservePerUnit * tx.qty)) || !tx.adCampaignId || !(isAdSale(tx) || (tx.deliveryStatus === 'cancelled' && isAdSale({...tx,category:'ขายสินค้า'}))))) return false;
    if (tx.adAutomatic != null && (tx.adAutomatic !== true || !isAdSpend(tx) || tx.adWalletFunded !== true || tx.id !== 'ad-auto-'+tx.adCampaignId+'-'+tx.date)) return false;
    if (tx.adWalletFunded != null && (typeof tx.adWalletFunded !== 'boolean' || !isAdSpend(tx))) return false;
    if (!tx.adCampaignId) return tx.adCampaignId == null && tx.adAllocations == null;
    const c = campaigns.find(c => c.id === tx.adCampaignId);
    if (!c) return false;
    if (tx.adAutomatic) {
      const h=c.autoHistory?.filter(h=>h.date<=tx.date).at(-1);
      if (!h || !h.enabled || h.status!=='active' || tx.date<h.startDate || (h.runMode==='dated' && tx.date>h.endDate) || tx.amount>h.dailyBudget) return false;
    }
    if (isAdSpend(tx)) {
      const a = tx.adAllocations;
      return cash(tx.amount) && tx.amount > 0 && (a == null ? campaignProductIds(c).length === 1 : Array.isArray(a) && a.length > 0 &&
        new Set(a.map(row => row?.productId)).size === a.length && a.every(row => row && campaignHasProduct(c, row.productId) && cash(row.amount)) &&
        Math.abs(a.reduce((sum,row) => sum + row.amount, 0) - tx.amount) < .001);
    }
    if (tx.deliveryStatus === "cancelled" && tx.category === "ขายสินค้ายกเลิก") tx = {...tx,category:"ขายสินค้า"};
    return isAdSale(tx) && products.some(p => campaignHasProduct(c,p.id) && saleMatchesProduct(tx,p)) && cash(tx.amount) && Number.isSafeInteger(tx.qty) && tx.qty > 0;
  });
}

// Automatic entries are estimates from completed Bangkok calendar days, not platform receipts.
const autoSnapshot = (c, wallet, date) => ({date, startDate:c.startDate, endDate:c.endDate,
  runMode:c.runMode || 'dated', status:c.status, dailyBudget:c.dailyBudget || 0,
  enabled:c.autoDeduct !== false, productIds:campaignProductIds(c)});
function ensureAutoHistory(c, wallet, today) {
  if (!c.autoHistory && c.dailyBudget > 0) c.autoHistory=[autoSnapshot(c,wallet,c.startDate < today ? c.startDate : today)];
}
function validAutoHistory(c) {
  return (c.autoDeduct == null || typeof c.autoDeduct === 'boolean') && (c.autoHistory == null ||
    (Array.isArray(c.autoHistory) && c.autoHistory.length>0 && c.autoHistory.every((h,i)=>h && dateValid(h.date) &&
      (!i || h.date>c.autoHistory[i-1].date) && dateValid(h.startDate) && ['dated','until_budget'].includes(h.runMode) &&
      (h.runMode==='until_budget' ? h.endDate==='' : dateValid(h.endDate) && h.endDate>=h.startDate) &&
      Object.hasOwn(adStatuses,h.status) && cash(h.dailyBudget) && typeof h.enabled==='boolean' &&
      (h.baseBudget == null || (Number.isFinite(h.baseBudget) && cash(Math.abs(h.baseBudget)))) && Array.isArray(h.productIds) && h.productIds.length>0 &&
      new Set(h.productIds).size===h.productIds.length && h.productIds.every(id=>campaignHasProduct(c,id)))));
}
export function reconcileAutomaticAds(state, today) {
  if (!dateValid(today)) throw new Error('วันที่คำนวณค่าแอดไม่ถูกต้อง');
  const campaigns=structuredClone(state.adCampaigns), wallet=state.adWallet || [];
  const actual=state.transactions.filter(tx=>tx.adAutomatic !== true);
  const actualIds=new Set(actual.map(tx=>tx.id));
  const previousAuto=new Map(state.transactions.filter(tx=>tx.adAutomatic===true).map(tx=>[tx.id,tx]));
  campaigns.forEach(c=>ensureAutoHistory(c,wallet,today));
  const candidates=campaigns.filter(c=>c.autoHistory?.length).sort((a,b)=>a.id.localeCompare(b.id));
  const generated=[];
  if (candidates.length && wallet.length) {
    const first=[...candidates.map(c=>c.autoHistory[0].date)].sort()[0];
    const fundedFrom=wallet.map(e=>e.date).sort()[0];
    const start=first>fundedFrom ? first : fundedFrom;
    // Bound imported dates before building a daily ledger.
    if ((Date.parse(today)-Date.parse(start))/86400000>36600) throw new Error('ช่วงคำนวณค่าแอดยาวเกิน 100 ปี กรุณาตรวจวันที่');
    const deposits=new Map(), payments=new Map(), manualDays=new Set();
    const add=(map,key,value)=>map.set(key,money((map.get(key)||0)+value));
    wallet.forEach(e=>add(deposits,e.date,e.amount));
    actual.filter(isAdSpend).forEach(tx=>{if(tx.adWalletFunded)add(payments,tx.date,tx.amount);manualDays.add(tx.adCampaignId+'|'+tx.date);});
    let credit=money(wallet.filter(e=>e.date<start).reduce((s,e)=>s+e.amount,0)-actual.filter(tx=>isAdSpend(tx)&&tx.adWalletFunded&&tx.date<start).reduce((s,tx)=>s+tx.amount,0));
    for(let timestamp=Date.parse(start);timestamp<Date.parse(today);timestamp+=86400000) {
      const date=new Date(timestamp).toISOString().slice(0,10);
      credit=money(credit+(deposits.get(date)||0)-(payments.get(date)||0));
      for(const c of candidates) {
        const key=c.id+'|'+date;
        const h=c.autoHistory.filter(h=>h.date<=date).at(-1);
        if (!h || !h.enabled || h.status!=='active' || !h.dailyBudget || date<h.startDate || (h.runMode==='dated'&&date>h.endDate) || manualDays.has(key)) continue;
        const amount=money(Math.max(0,Math.min(h.dailyBudget,credit)));
        if (!amount) continue;
        const id='ad-auto-'+c.id+'-'+date;
        if(actualIds.has(id)) throw new Error('รหัสรายการค่าแอดอัตโนมัติซ้ำ กรุณาตรวจประวัติ');
        const previous=previousAuto.get(id);
        generated.push({id,adCampaignId:c.id,adAutomatic:true,adWalletFunded:true,type:'expense',category:'ค่าโฆษณาสินค้า',amount,date,
          adAllocations:previous?.amount===amount && previous.adAllocations ? previous.adAllocations : allocateAdSpend(amount,h.productIds),desc:`${c.name} · หักอัตโนมัติตามงบต่อวัน (ประมาณการ)`});
        credit=money(credit-amount);
      }
    }
  }
  return {adCampaigns:campaigns,adWallet:structuredClone(wallet),transactions:[...generated.reverse(),...actual]};
}

// Returns new arrays only after all validations pass; caller commits them atomically.
export function applyAdAction(state, action, id, today) {
  let campaigns = structuredClone(state.adCampaigns), transactions = structuredClone(state.transactions);
  let wallet = structuredClone(state.adWallet || []);
  if (['topup', 'removeTopup'].includes(action.type)) {
    if (JSON.stringify(wallet) !== action.expectedWallet) throw new Error('ยอดเติมเงินเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดแล้วลองอีกครั้ง');
    if (action.type === 'topup') {
      if (!dateValid(action.date) || action.date > today) throw new Error('วันที่เติมเงินต้องไม่เกินวันนี้');
      const entry = {id, amount:action.amount, date:action.date, note:action.note};
      if (action.campaignId != null) {
        const c = campaigns.find(c=>c.id===action.campaignId);
        if (!c || JSON.stringify(c)!==action.expected) throw new Error('แคมเปญเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุด');
        entry.campaignId=c.id;
      }
      wallet.unshift(entry);
    } else {
      const entry=wallet.find(e=>e.id===action.entryId);
      if (!entry) throw new Error('ไม่พบรายการเติมเงิน');
      if (entry.campaignId) {
        const c=campaigns.find(c=>c.id===entry.campaignId);
        if (!c || JSON.stringify(c)!==action.expected) throw new Error('แคมเปญเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุด');
      }
      wallet = wallet.filter(e => e.id !== action.entryId);
    }
    if (!validateAdWallet(wallet,campaigns)) throw new Error('ยอดเติมเงินต้องมากกว่า 0 ทศนิยมไม่เกิน 2 ตำแหน่ง และหมายเหตุไม่เกิน 500 ตัวอักษร');
    return reconcileAutomaticAds({...state,adCampaigns:campaigns,transactions,adWallet:wallet},today);
  }
  const campaign = campaigns.find(c => c.id === action.campaignId);
  if (action.type !== 'create' && (!campaign || JSON.stringify(campaign) !== action.expected)) throw new Error('แคมเปญเปลี่ยนแปลง กรุณาเปิดรายการล่าสุดแล้วลองอีกครั้ง');
  const selectedIds = campaignProductIds(action.type === 'create' ? action.values : campaign);
  const selectedProducts = state.products.filter(p => selectedIds.includes(p.id));
  if (!selectedIds.length || selectedProducts.length !== selectedIds.length) throw new Error('ไม่พบสินค้าที่ผูกกับแคมเปญ');
  if (['create', 'edit'].includes(action.type)) {
    const next = { ...action.values, id: campaign?.id || id };
    delete next.autoHistory;
    delete next.budget;
    if(campaign) {
      ensureAutoHistory(campaign,wallet,today);
      if(campaign.autoHistory) next.autoHistory=[...campaign.autoHistory.filter(h=>h.date<today),autoSnapshot(next,wallet,today)];
    }
    if (!validateAdCampaign(next) || campaignProductIds(next).some(id => !state.products.some(p => p.id === id))) throw new Error('กรุณาตรวจชื่อสินค้า งบ จำนวนเป้าหมาย วันที่ และสัดส่วนเก็บกำไร 0–100%');
    if (campaign) {
      const removed = selectedProducts.filter(p => !campaignHasProduct(next,p.id));
      if (removed.some(p => transactions.some(tx => tx.adCampaignId === campaign.id &&
        ((isAdSpend(tx) && adSpendAllocations(tx,campaign).some(a => a.productId === p.id)) || saleMatchesProduct(tx,p) || (tx.deliveryStatus === "cancelled" && saleMatchesProduct({...tx,category:"ขายสินค้า"},p))))))
        throw new Error('สินค้าที่มีต้นทุนหรือยอดขายผูกอยู่แล้วไม่สามารถนำออกได้ แต่เพิ่มสินค้าอื่นได้');
      // Preserve the reserve rate already attached to historical sales before changing it.
      if (campaign.reservePerUnit != null) transactions.filter(tx => tx.adCampaignId === campaign.id && tx.adReservePerUnit == null && (isAdSale(tx) || tx.deliveryStatus === 'cancelled')).forEach(tx => { tx.adReservePerUnit = campaign.reservePerUnit; });
      // Freeze historical shares before adding products, including old single-product campaigns.
      transactions.filter(tx => tx.adCampaignId === campaign.id && isAdSpend(tx) && !tx.adAllocations).forEach(tx => { tx.adAllocations = adSpendAllocations(tx,campaign); });
    }
    campaigns = campaign ? campaigns.map(c => c.id === campaign.id ? next : c) : [next, ...campaigns];
  } else if (action.type === 'toggle') {
    if (typeof action.enabled !== 'boolean') throw new Error('สถานะเปิด–ปิดไม่ถูกต้อง');
    if (action.enabled && !(campaign.dailyBudget > 0)) throw new Error('กรุณาระบุงบยิงแอดต่อวันในรายละเอียดก่อนเปิดหักเงิน');
    ensureAutoHistory(campaign,wallet,today);
    campaign.status = action.enabled ? 'active' : 'paused';
    campaign.autoDeduct = action.enabled;
    campaign.autoHistory = [...(campaign.autoHistory || []).filter(h=>h.date<today),autoSnapshot(campaign,wallet,today)];
  } else if (action.type === 'spend') {
    if (action.adWalletFunded != null && typeof action.adWalletFunded !== 'boolean') throw new Error('แหล่งชำระค่าแอดไม่ถูกต้อง');
    if (!cash(action.amount) || action.amount <= 0 || !dateValid(action.date) || action.date > today || !textValid(action.note, 500)) throw new Error('ระบุค่าแอดที่จ่ายจริงมากกว่า 0 และวันที่จ่ายไม่เกินวันนี้');
    transactions.unshift({ id, adCampaignId: campaign.id, adWalletFunded:action.adWalletFunded === true, type: 'expense', category: 'ค่าโฆษณาสินค้า', amount: action.amount, date: action.date, adAllocations: allocateAdSpend(action.amount, selectedIds), desc: `${campaign.name} · ${selectedProducts.map(p => p.name).join(', ')}${action.note ? ' · ' + action.note : ''}` });
  } else if (['link', 'unlink', 'removeSpend'].includes(action.type)) {
    const tx = transactions.find(t => t.id === action.transactionId);
    if (!tx || JSON.stringify(tx) !== action.expectedTransaction) throw new Error('รายการบัญชีเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุด');
    if (action.type === 'link') {
      const product = selectedProducts.find(p => saleMatchesProduct(tx,p));
      if (!product || tx.adCampaignId) throw new Error('เลือกยอดขายของสินค้านี้ที่ยังไม่ผูกกับแคมเปญอื่น');
      tx.adCampaignId = campaign.id;
      if (campaign.reservePerUnit != null) {
        if (!cash(money(campaign.reservePerUnit * tx.qty))) throw new Error("ยอดแบ่งยิงแอดรวมสูงเกินกำหนด");
        tx.adReservePerUnit = campaign.reservePerUnit;
      }
      tx.stockProductId = product.id;
    } else {
      if (tx.adCampaignId !== campaign.id) throw new Error('รายการนี้ไม่ได้ผูกกับแคมเปญ');
      if (action.type === 'removeSpend') {
        if (!isAdSpend(tx)) throw new Error('รายการนี้ไม่ใช่ค่าแอด');
        if (tx.adAutomatic) throw new Error('รายการนี้คำนวณอัตโนมัติ ให้บันทึกยอดใช้จริงของวันนั้นแทน หรือปรับการหักอัตโนมัติในแคมเปญ');
        transactions = transactions.filter(t => t.id !== tx.id);
      } else {
        if (!isAdSale(tx)) throw new Error('รายการนี้ไม่ใช่ยอดขาย');
        delete tx.adCampaignId;
        delete tx.adReservePerUnit;
      }
    }
  } else if (action.type === 'delete') {
    if (wallet.some(e=>e.campaignId===campaign.id)) throw new Error('แคมเปญมีประวัติเติมเงินแล้ว ให้เปลี่ยนสถานะเพื่อเก็บประวัติ');
    if (transactions.some(tx => tx.adCampaignId === campaign.id)) throw new Error('แคมเปญมีค่าใช้จ่ายหรือยอดขายแล้ว ให้เปลี่ยนสถานะเป็นจบแคมเปญเพื่อเก็บประวัติ');
    campaigns = campaigns.filter(c => c.id !== campaign.id);
  } else throw new Error('ไม่รองรับคำสั่งนี้');
  return reconcileAutomaticAds({...state,adCampaigns:campaigns,transactions,adWallet:wallet},today);
}
