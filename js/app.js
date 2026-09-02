import { stockDatabase, firebaseConfigured } from './firebase-service.js';

const STORE_PRODUCTS = 'shop_products_v2';
const STORE_PRODUCTS_OLD = 'shop_products_v1';
const STORE_TX = 'shop_transactions_v1';
const STORE_PENDING = 'shop_pending_v1';

let products = [];
let transactions = [];
let pendingOrders = [];
let activeTab = 'home';
let loaded = false;
let loadError = false;
let stockSearch = '';
let editingVariantId = null;
let aiResult = null;
let aiLoading = false;
let aiError = null;
let monthlyChartInstance = null;
let topChartInstance = null;
let shipmentDraft = { amount: '', date: '', rows: [{ variantId: '', qty: 1 }] };
const LOW_STOCK_THRESHOLD = 1;

const app = document.getElementById('app');
const fmtMoney = n => '฿' + Number(n||0).toLocaleString('th-TH', {maximumFractionDigits:2});
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const todayStr = () => new Date().toISOString().slice(0,10);
const monthKey = d => d.slice(0,7);
const monthLabel = key => {
  const [y,m] = key.split('-');
  const names = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  return names[parseInt(m,10)-1] + ' ' + (parseInt(y,10)+543);
};

// ---------- Custom modal (replaces native confirm/alert, which can be blocked) ----------
let modalResolve = null;
function showConfirm(message){
  return new Promise(resolve=>{
    modalResolve = resolve;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('modal-cancel-btn').style.display = 'inline-block';
    document.getElementById('modal-ok-btn').textContent = 'ยืนยัน';
    document.getElementById('modal-overlay').classList.add('show');
  });
}
function showAlert(message){
  return new Promise(resolve=>{
    modalResolve = resolve;
    document.getElementById('modal-message').textContent = message;
    document.getElementById('modal-cancel-btn').style.display = 'none';
    document.getElementById('modal-ok-btn').textContent = 'ตกลง';
    document.getElementById('modal-overlay').classList.add('show');
  });
}
function closeModal(result){
  document.getElementById('modal-overlay').classList.remove('show');
  if(modalResolve) modalResolve(result);
  modalResolve = null;
}
document.getElementById('modal-ok-btn').onclick = ()=> closeModal(true);
document.getElementById('modal-cancel-btn').onclick = ()=> closeModal(false);
document.getElementById('modal-overlay').onclick = (e)=>{ if(e.target.id==='modal-overlay') closeModal(false); };
document.getElementById('detail-close-btn').onclick = closeDetail;
document.getElementById('detail-overlay').onclick = (e)=>{ if(e.target.id==='detail-overlay') closeDetail(); };
document.getElementById('edit-cancel-btn').onclick = closeEdit;
wireToggleLabels(document.getElementById('edit-form'));
document.getElementById('edit-overlay').onclick = (e)=>{ if(e.target.id==='edit-overlay') closeEdit(); };

let payingTxId = null;
function openPaymentModal(txId){
  const tx = transactions.find(t=>t.id===txId && t.type==='installment');
  if(!tx) return;
  payingTxId = txId;
  const remaining = tx.amount - (tx.paidAmount||0);
  document.getElementById('payment-info').textContent = (tx.desc||'') + ' — ค้างชำระ ' + fmtMoney(remaining);
  document.getElementById('payment-amount').value = remaining.toFixed(2);
  document.getElementById('payment-overlay').classList.add('show');
}
function closePayment(){
  payingTxId = null;
  document.getElementById('payment-overlay').classList.remove('show');
}
document.getElementById('payment-cancel-btn').onclick = closePayment;
document.getElementById('payment-overlay').onclick = (e)=>{ if(e.target.id==='payment-overlay') closePayment(); };
document.getElementById('payment-submit-btn').onclick = async ()=>{
  if(!payingTxId) return;
  const amountVal = document.getElementById('payment-amount').value;
  const ok = await recordInstallmentPayment(payingTxId, amountVal);
  if(ok) closePayment();
};

// ---------- Load / migrate / save ----------
function migrateFlatProducts(raw){
  // Old format: flat list of {id,name,color,size,type,cost,price,qty,image,createdAt}
  // New format: [{id,name,image,createdAt,variants:[{id,color,size,type,cost,price,qty,createdAt}]}]
  if(!Array.isArray(raw) || raw.length===0) return [];
  const map = {};
  const order = [];
  raw.forEach(item=>{
    const key = (item.name||'').trim().toLowerCase();
    if(!map[key]){
      map[key] = { id: uid(), name: (item.name||'').trim(), image: item.image||null, createdAt: item.createdAt||todayStr(), variants: [] };
      order.push(key);
    }
    if(!map[key].image && item.image) map[key].image = item.image;
    map[key].variants.push({
      id: item.id || uid(), color: item.color||'', size: item.size||'', type: item.type||'new',
      cost: Number(item.cost)||0, price: Number(item.price)||0, qty: Number(item.qty)||0,
      createdAt: item.createdAt||todayStr()
    });
  });
  return order.map(k=>map[k]);
}

async function loadAll(){
  if(!firebaseConfigured){
    loadError = true;
    render();
    return;
  }
  try{
    products = await stockDatabase.get('products');

    if(products === null){
      products = [];
    }
    if(!Array.isArray(products)) products = [];

    transactions = await stockDatabase.get('transactions') || [];

    pendingOrders = await stockDatabase.get('pendingOrders') || [];
    if(!Array.isArray(pendingOrders)) pendingOrders = [];

    loaded = true;
    subscribeToStoreChanges();
  }catch(e){
    loadError = true;
    console.error('load error', e);
  }
  render();
}

function subscribeToStoreChanges(){
  stockDatabase.subscribe('products', value=>{
    products = Array.isArray(value) ? value : [];
    if(loaded) render();
  });
  stockDatabase.subscribe('transactions', value=>{
    transactions = Array.isArray(value) ? value : [];
    if(loaded) render();
  });
  stockDatabase.subscribe('pendingOrders', value=>{
    pendingOrders = Array.isArray(value) ? value : [];
    if(loaded) render();
  });
}

async function saveProducts(){
  try{ await stockDatabase.set('products', products); }
  catch(e){ console.error('save products failed', e); showAlert('บันทึกข้อมูลสินค้าไม่สำเร็จ ลองอีกครั้ง'); }
}
async function saveTx(){
  try{ await stockDatabase.set('transactions', transactions); }
  catch(e){ console.error('save tx failed', e); showAlert('บันทึกรายการบัญชีไม่สำเร็จ ลองอีกครั้ง'); }
}
async function savePending(){
  try{ await stockDatabase.set('pendingOrders', pendingOrders); }
  catch(e){ console.error('save pending failed', e); showAlert('บันทึกรายการรอรับของไม่สำเร็จ ลองอีกครั้ง'); }
}

// ---------- Backup export / import ----------
function exportData(){
  const payload = { exportedAt: new Date().toISOString(), version: 3, products, transactions, pendingOrders };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'crazsix-store-backup-' + todayStr() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function handleImportFile(e){
  const file = e.target.files[0];
  if(!file) return;
  try{
    const text = await file.text();
    const data = JSON.parse(text);
    if(!data || !Array.isArray(data.products) || !Array.isArray(data.transactions)){
      showAlert('ไฟล์นี้ไม่ใช่ไฟล์สำรองข้อมูลของระบบนี้');
      e.target.value = '';
      return;
    }
    if(!(await showConfirm('นำเข้าข้อมูลนี้จะเขียนทับข้อมูลปัจจุบันทั้งหมด ต้องการดำเนินการต่อหรือไม่?'))){
      e.target.value = '';
      return;
    }
    let importedProducts = data.products;
    if(importedProducts.length > 0 && !importedProducts[0].variants){
      importedProducts = migrateFlatProducts(importedProducts);
    }
    products = importedProducts;
    transactions = data.transactions;
    pendingOrders = Array.isArray(data.pendingOrders) ? data.pendingOrders : [];
    await saveProducts();
    await saveTx();
    await savePending();
    e.target.value = '';
    render();
  }catch(err){
    console.error('import failed', err);
    showAlert('นำเข้าข้อมูลไม่สำเร็จ ไฟล์อาจเสียหายหรือไม่ถูกต้อง');
    e.target.value = '';
  }
}

// ---------- Data helpers ----------
function allVariants(){
  const list = [];
  products.forEach(prod=> prod.variants.forEach(v=> list.push({product:prod, variant:v})));
  return list;
}
function findVariant(variantId){
  for(const prod of products){
    const v = prod.variants.find(x=>x.id===variantId);
    if(v) return {product: prod, variant: v};
  }
  return null;
}
function variantLabel(product, variant){
  const parts = [product.name];
  if(variant.color) parts.push(variant.color);
  if(variant.size) parts.push('ไซส์ ' + variant.size);
  parts.push(variant.type==='used' ? 'มือ2' : 'มือ1');
  return parts.join(' · ');
}
function stockValue(){
  return allVariants().reduce((s,{variant})=> s + variant.cost*variant.qty, 0);
}
function lowStockVariants(){
  return allVariants().filter(({variant}) => variant.type==='new' && variant.qty>0 && variant.qty<=LOW_STOCK_THRESHOLD);
}
function txForMonth(key){
  return transactions.filter(t => monthKey(t.date) === key);
}
function monthSummary(key){
  const list = txForMonth(key);
  const income = list.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0);
  const expense = list.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0);
  return {income, expense, profit: income-expense};
}
function variantStats(variantId){
  const sales = transactions.filter(t=>t.productId===variantId && t.category==='ขายสินค้า' && t.profit!=null);
  return summarizeSales(sales);
}
function productAggregateStats(productId){
  const prod = products.find(p=>p.id===productId);
  if(!prod) return summarizeSales([]);
  const ids = prod.variants.map(v=>v.id);
  const sales = transactions.filter(t=>ids.includes(t.productId) && t.category==='ขายสินค้า' && t.profit!=null);
  return summarizeSales(sales);
}
function summarizeSales(sales){
  const totalQtySold = sales.reduce((s,t)=>s+(t.qty||0),0);
  const totalProfit = sales.reduce((s,t)=>s+(t.profit||0),0);
  const byMonth = {};
  sales.forEach(t=>{
    const k = monthKey(t.date);
    if(!byMonth[k]) byMonth[k] = {qty:0, profit:0};
    byMonth[k].qty += t.qty||0;
    byMonth[k].profit += t.profit||0;
  });
  const months = Object.keys(byMonth).sort().reverse().map(k=>({key:k, ...byMonth[k]}));
  return {totalQtySold, totalProfit, months};
}
function topSellers(limit, sortBy){
  const map = {};
  products.forEach(p=>{
    const agg = productAggregateStats(p.id);
    if(agg.totalQtySold>0) map[p.id] = {name:p.name, qty:agg.totalQtySold, profit:agg.totalProfit};
  });
  return Object.values(map).sort((a,b)=> sortBy==='profit' ? b.profit-a.profit : b.qty-a.qty).slice(0,limit);
}
function last6MonthsKeys(){
  const arr=[];
  const now = new Date();
  for(let i=5;i>=0;i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    arr.push(d.toISOString().slice(0,7));
  }
  return arr;
}

// ---------- Actions ----------
function addVariantCore(data){
  const key = data.name.trim().toLowerCase();
  let prod = products.find(p=>p.name.trim().toLowerCase()===key);
  const variant = {
    id: uid(), color: data.color, size: data.size, type: data.type,
    cost: data.cost, price: data.price, qty: data.qty, createdAt: todayStr()
  };
  if(prod){
    prod.variants.unshift(variant);
    if(data.image) prod.image = data.image;
  }else{
    prod = { id: uid(), name: data.name.trim(), image: data.image||null, createdAt: todayStr(), variants:[variant] };
    products.unshift(prod);
  }
  return {prod, variant};
}

async function addProductOrVariant(data){
  const {prod, variant} = addVariantCore(data);
  await saveProducts();
  let txAdded = false;
  if(data.logExpense && data.cost*data.qty > 0){
    transactions.unshift({
      id: uid(), type:'expense', category:'ซื้อสินค้าเข้าสต็อก',
      desc: variantLabel(prod, variant),
      amount: data.cost*data.qty, date: todayStr(), productId: variant.id
    });
    txAdded = true;
  }
  const shippingIn = parseFloat(data.shippingIn)||0;
  if(shippingIn > 0){
    transactions.unshift({
      id: uid(), type:'expense', category:'ค่าส่งสินค้าเข้า',
      desc: variantLabel(prod, variant) + ' (ค่าส่งจากต้นทาง)',
      amount: shippingIn, date: todayStr(), productId: variant.id
    });
    txAdded = true;
  }
  if(txAdded) await saveTx();
  render();
}

// base: {name,color,type,price,image,logExpense,shippingIn}; rows: [{size,qty,cost}]
async function addProductBatch(base, rows){
  const created = rows.map(r => addVariantCore({
    name: base.name, color: r.color, size: r.size, type: base.type,
    cost: r.cost, price: base.price, qty: r.qty, image: base.image
  }));
  await saveProducts();
  let txAdded = false;
  if(base.logExpense){
    created.forEach(({prod, variant})=>{
      if(variant.cost*variant.qty > 0){
        transactions.unshift({
          id: uid(), type:'expense', category:'ซื้อสินค้าเข้าสต็อก',
          desc: variantLabel(prod, variant),
          amount: variant.cost*variant.qty, date: todayStr(), productId: variant.id
        });
        txAdded = true;
      }
    });
  }
  const shippingIn = parseFloat(base.shippingIn)||0;
  if(shippingIn > 0){
    const desc = created.map(({prod,variant})=> variantLabel(prod,variant)).join(', ');
    transactions.unshift({
      id: uid(), type:'expense', category:'ค่าส่งสินค้าเข้า',
      desc: desc + ' (ค่าส่งจากต้นทาง)',
      amount: shippingIn, date: todayStr(), productId: null
    });
    txAdded = true;
  }
  if(txAdded) await saveTx();
  render();
}

async function attachShippingBulk(items, amount, date){
  const labels = items.map(it=> it.label + ' x' + it.qty);
  transactions.unshift({
    id: uid(), type:'expense', category:'ค่าส่งสินค้าเข้า (เหมาล็อต)',
    desc: labels.join(', '),
    amount, date: date || todayStr(),
    items: items.map(it=>({productId: it.variantId, qty: it.qty}))
  });
  await saveTx();
  render();
}

// ---------- Pending orders (paid for, not yet physically received) ----------
function pendingLabel(po){
  const parts = [po.name];
  if(po.color) parts.push(po.color);
  if(po.size) parts.push('ไซส์ ' + po.size);
  parts.push(po.type==='used' ? 'มือ2' : 'มือ1');
  return parts.join(' · ');
}

function addPendingOrderCore(data){
  const po = {
    id: uid(), name: data.name, color: data.color, size: data.size, type: data.type,
    cost: data.cost, price: data.price, qty: data.qty, image: data.image||null,
    orderDate: todayStr(), note: (data.note||'').trim()
  };
  pendingOrders.unshift(po);
  return po;
}

// rows: [{name,color,size,type,qty,cost,price}]; note: shared order note for all rows
async function addPendingOrderBatch(rows, note){
  const created = rows.map(r => addPendingOrderCore({...r, note}));
  await savePending();
  const totalCost = created.reduce((s,po)=> s + po.cost*po.qty, 0);
  if(totalCost > 0){
    const desc = created.map(po=> pendingLabel(po) + ' x' + po.qty).join(', ');
    transactions.unshift({
      id: uid(), type:'expense', category:'สั่งซื้อสินค้า (รอของมาส่ง)',
      desc, amount: totalCost, date: todayStr(), pendingIds: created.map(po=>po.id)
    });
    await saveTx();
  }
  render();
}

async function receivePendingOrder(pendingId, shippingPaid){
  const idx = pendingOrders.findIndex(p=>p.id===pendingId);
  if(idx===-1) return;
  const po = pendingOrders[idx];
  const {prod, variant} = addVariantCore({
    name: po.name, color: po.color, size: po.size, type: po.type,
    cost: po.cost, price: po.price, qty: po.qty, image: po.image
  });
  pendingOrders.splice(idx,1);
  await saveProducts();
  await savePending();
  const shipAmt = parseFloat(shippingPaid)||0;
  if(shipAmt > 0){
    transactions.unshift({
      id: uid(), type:'expense', category:'ค่าส่งสินค้าเข้า',
      desc: variantLabel(prod, variant) + ' (ค่าส่งตอนรับของ)',
      amount: shipAmt, date: todayStr(), productId: variant.id
    });
    await saveTx();
  }
  render();
}

async function deletePendingOrder(pendingId){
  if(!(await showConfirm('ยกเลิกรายการสั่งซื้อนี้? (ยอดที่จ่ายไปแล้วจะยังอยู่ในบัญชีรายจ่าย ไม่ถูกลบ)'))) return;
  pendingOrders = pendingOrders.filter(p=>p.id!==pendingId);
  await savePending();
  render();
}

async function restockVariant(variantId, data){
  const found = findVariant(variantId);
  if(!found) return;
  const {product, variant} = found;
  const addQty = data.qty;
  let batchCost = variant.cost;
  if(data.cost != null && !isNaN(data.cost)){
    batchCost = data.cost;
    const totalOldValue = variant.qty * variant.cost;
    const totalNewValue = addQty * data.cost;
    const newQty = variant.qty + addQty;
    variant.cost = newQty>0 ? (totalOldValue + totalNewValue) / newQty : data.cost;
  }
  variant.qty += addQty;
  if(data.price != null && !isNaN(data.price)) variant.price = data.price;
  await saveProducts();
  let txAdded = false;
  if(data.logExpense && batchCost*addQty > 0){
    transactions.unshift({
      id: uid(), type:'expense', category:'เติมสต็อกสินค้าเดิม',
      desc: variantLabel(product, variant) + ' +' + addQty,
      amount: batchCost*addQty, date: todayStr(), productId: variant.id
    });
    txAdded = true;
  }
  const shippingIn = parseFloat(data.shippingIn)||0;
  if(shippingIn > 0){
    transactions.unshift({
      id: uid(), type:'expense', category:'ค่าส่งสินค้าเข้า',
      desc: variantLabel(product, variant) + ' (ค่าส่งจากต้นทาง)',
      amount: shippingIn, date: todayStr(), productId: variant.id
    });
    txAdded = true;
  }
  if(txAdded) await saveTx();
  render();
}

async function editVariant(variantId, data){
  const found = findVariant(variantId);
  if(!found) return;
  const {product, variant} = found;
  product.name = data.name.trim();
  if(data.image) product.image = data.image;
  variant.color = data.color;
  variant.size = data.size;
  variant.type = data.type;
  variant.cost = data.cost;
  variant.price = data.price;
  variant.qty = data.qty;
  await saveProducts();
  render();
}

async function deleteVariant(variantId){
  if(!(await showConfirm('ลบสินค้านี้ออกจากสต็อก?'))) return;
  const found = findVariant(variantId);
  if(!found) return;
  const {product} = found;
  product.variants = product.variants.filter(v=>v.id!==variantId);
  if(product.variants.length===0){
    products = products.filter(p=>p.id!==product.id);
  }
  await saveProducts();
  render();
}

function addDaysStr(days){
  const d = new Date();
  d.setDate(d.getDate() + (parseInt(days,10)||30));
  return d.toISOString().slice(0,10);
}

async function sellVariant(variantId, data){
  const found = findVariant(variantId);
  if(!found) return;
  const {product, variant} = found;
  const qty = parseInt(data.qty,10);
  const sellPrice = parseFloat(data.sellPrice);
  const shipping = parseFloat(data.shipping)||0;
  const commission = parseFloat(data.commission)||0;
  const isInstallment = !!data.installment;
  if(!qty || qty<1){ showAlert('ระบุจำนวนที่จะขายให้ถูกต้อง'); return; }
  if(qty > variant.qty){ showAlert('สินค้าคงเหลือไม่พอ (เหลือ ' + variant.qty + ' ชิ้น)'); return; }
  if(!sellPrice || sellPrice<0){ showAlert('ระบุราคาขายจริงให้ถูกต้อง'); return; }

  variant.qty -= qty;
  await saveProducts();

  const revenue = sellPrice*qty;
  const profit = revenue - (variant.cost*qty) - shipping - commission;

  if(isInstallment){
    const saleId = uid();
    const deposit = Math.max(0, Math.min(parseFloat(data.deposit)||0, revenue));
    const note = (data.customerNote||'').trim();
    transactions.unshift({
      id: saleId, type:'installment', category:'ขายสินค้า',
      desc: variantLabel(product, variant) + ' x' + qty + (note ? ' — '+note : '') + ' (ผ่อนชำระ)',
      amount: revenue, date: todayStr(), productId: variant.id, qty,
      unitPrice: sellPrice, unitCost: variant.cost, shipping, commission, profit,
      paidAmount: deposit, dueDate: addDaysStr(data.dueDays), customerNote: note
    });
    if(deposit>0){
      transactions.unshift({
        id: uid(), type:'income', category:'รับชำระค่าผ่อน (มัดจำแรก)',
        desc: variantLabel(product,variant), amount: deposit, date: todayStr(), installmentId: saleId, productId: variant.id
      });
    }
  }else{
    transactions.unshift({
      id: uid(), type:'income', category:'ขายสินค้า',
      desc: variantLabel(product, variant) + ' x' + qty,
      amount: revenue, date: todayStr(), productId: variant.id, qty,
      unitPrice: sellPrice, unitCost: variant.cost, shipping, commission, profit
    });
  }
  if(shipping>0){
    transactions.unshift({ id: uid(), type:'expense', category:'ค่าส่ง', desc: variantLabel(product,variant) + ' x' + qty, amount: shipping, date: todayStr(), productId: variant.id });
  }
  if(commission>0){
    transactions.unshift({ id: uid(), type:'expense', category:'ค่ากลาง', desc: variantLabel(product,variant) + ' x' + qty, amount: commission, date: todayStr(), productId: variant.id });
  }
  await saveTx();
  render();
}

function openInstallments(){
  return transactions.filter(t=>t.type==='installment' && (t.amount - (t.paidAmount||0)) > 0.001);
}

async function recordInstallmentPayment(saleTxId, amountStr){
  const sale = transactions.find(t=>t.id===saleTxId && t.type==='installment');
  if(!sale) return false;
  const amount = parseFloat(amountStr);
  const remaining = sale.amount - (sale.paidAmount||0);
  if(!amount || amount<=0){ showAlert('ระบุจำนวนเงินให้ถูกต้อง'); return false; }
  if(amount > remaining + 0.001){ showAlert('จำนวนเงินเกินยอดค้างชำระ (' + fmtMoney(remaining) + ')'); return false; }
  sale.paidAmount = (sale.paidAmount||0) + amount;
  transactions.unshift({
    id: uid(), type:'income', category:'รับชำระค่าผ่อน',
    desc: sale.desc, amount, date: todayStr(), installmentId: sale.id, productId: sale.productId
  });
  await saveTx();
  render();
  return true;
}

async function addManualTx(data){
  transactions.unshift({
    id: uid(), type: data.type, category: data.category || (data.type==='income'?'รายรับอื่นๆ':'รายจ่ายอื่นๆ'),
    desc: data.desc, amount: data.amount, date: data.date || todayStr()
  });
  await saveTx();
  render();
}

async function deleteTx(id){
  if(!(await showConfirm('ลบรายการนี้?'))) return;
  transactions = transactions.filter(t=>t.id!==id);
  await saveTx();
  render();
}

async function resetAll(){
  if(!(await showConfirm('ล้างข้อมูลสินค้าและบัญชีทั้งหมด? การกระทำนี้ย้อนกลับไม่ได้'))) return;
  products = []; transactions = [];
  await saveProducts(); await saveTx();
  render();
}

function resizeImageFile(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = ()=>{
      const img = new Image();
      img.onerror = reject;
      img.onload = ()=>{
        const maxDim = 320;
        let w = img.width, h = img.height;
        if(w > h && w > maxDim){ h = Math.round(h * maxDim/w); w = maxDim; }
        else if(h > maxDim){ w = Math.round(w * maxDim/h); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.72));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- Render ----------
function render(){
  if(!loaded){
    app.innerHTML = loadError
      ? '<div class="loading">ยังเชื่อมต่อ Firebase ไม่ได้ — ตรวจสอบไฟล์ js/firebase-config.js และ Firestore Rules</div>'
      : '<div class="loading">กำลังโหลดข้อมูลร้าน...</div>';
    return;
  }
  const key = todayStr().slice(0,7);
  const ms = monthSummary(key);
  const totalItems = allVariants().length;

  app.innerHTML = `
    <header>
      <div class="clay header-clay">
        <p class="eyebrow">ระบบจัดการร้าน · เปิดอ่านได้ทุกอุปกรณ์</p>
        <h1>Crazsix Store</h1>
        <p class="subline">สต็อกคงเหลือ ${totalItems} ตัวเลือก (${products.length} สินค้า) · ข้อมูลบันทึกอัตโนมัติ และเห็นเหมือนกันทุกเครื่องที่เปิดหน้านี้</p>
        <div class="stats">
          <div class="stat clay"><div class="lbl">มูลค่าสต็อก (ต้นทุน)</div><div class="val">${fmtMoney(stockValue())}</div></div>
          <div class="stat clay"><div class="lbl">รายรับเดือนนี้</div><div class="val">${fmtMoney(ms.income)}</div></div>
          <div class="stat clay"><div class="lbl">รายจ่ายเดือนนี้</div><div class="val">${fmtMoney(ms.expense)}</div></div>
          <div class="stat clay-navy profit"><div class="lbl">กำไรเดือนนี้</div><div class="val">${fmtMoney(ms.profit)}</div></div>
        </div>
      </div>
    </header>

    <nav class="tabs clay-in">
      <button data-tab="home" class="${activeTab==='home'?'active':''}">หน้าหลัก</button>
      <button data-tab="stock" class="${activeTab==='stock'?'active':''}">สต็อกสินค้า</button>
      <button data-tab="sell" class="${activeTab==='sell'?'active':''}">ขายสินค้า</button>
      <button data-tab="installment" class="${activeTab==='installment'?'active':''}">ผ่อนชำระ${openInstallments().length>0 ? ' ('+openInstallments().length+')' : ''}</button>
      <button data-tab="tx" class="${activeTab==='tx'?'active':''}">บัญชีรายรับ-รายจ่าย</button>
      <button data-tab="report" class="${activeTab==='report'?'active':''}">รายงานกำไรรายเดือน</button>
      <button data-tab="ai" class="${activeTab==='ai'?'active':''}">AI วิเคราะห์แนวโน้ม</button>
    </nav>

    <div id="tab-content"></div>

    <footer>
      <div class="footer-actions">
        <button id="export-btn">ดาวน์โหลดฐานข้อมูล (สำรอง)</button>
        <label id="import-label" style="position:relative; cursor:pointer;">นำเข้าฐานข้อมูล<input type="file" id="import-input" accept="application/json" style="position:absolute; opacity:0; width:1px; height:1px; pointer-events:none;"></label>
        <button id="reset-btn">ล้างข้อมูลทั้งหมด</button>
      </div>
    </footer>
  `;

  document.querySelectorAll('nav.tabs button').forEach(b=>{
    b.onclick = () => { activeTab = b.dataset.tab; render(); };
  });
  document.getElementById('reset-btn').onclick = resetAll;
  document.getElementById('export-btn').onclick = exportData;
  document.getElementById('import-input').onchange = handleImportFile;
  document.getElementById('import-label').onclick = (e)=>{
    e.preventDefault();
    document.getElementById('import-input').click();
  };

  const content = document.getElementById('tab-content');
  if(activeTab==='home') content.innerHTML = renderHomeTab();
  else if(activeTab==='stock') content.innerHTML = renderStockTab();
  else if(activeTab==='sell') content.innerHTML = renderSellTab();
  else if(activeTab==='installment') content.innerHTML = renderInstallmentsTab();
  else if(activeTab==='tx') content.innerHTML = renderTxTab();
  else if(activeTab==='report') content.innerHTML = renderReportTab();
  else content.innerHTML = renderAiTab();

  wireHomeTab();
  wireStockTab();
  wireSellTab();
  wireInstallmentsTab();
  wireTxTab();
  wireReportTab();
  wireAiTab();
}

// ---------- Home tab ----------
function renderHomeTab(){
  const low = lowStockVariants();
  const q = stockSearch.trim().toLowerCase();

  const groups = products.map(prod=>{
    const variants = prod.variants.filter(v=>{
      if(!q) return true;
      return [prod.name, v.color, v.size].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
    return {prod, variants};
  }).filter(g=>g.variants.length>0);

  const alertBlock = low.length===0 ? '' : `
    <div class="alert-banner">
      <div class="alert-title">⚠️ สินค้ามือ1 ใกล้หมด (เหลือ ≤ ${LOW_STOCK_THRESHOLD} ชิ้น)</div>
      <div class="alert-list">
        ${low.map(({product,variant})=>`<span class="alert-chip">${escapeHtml(variantLabel(product,variant))} — เหลือ ${variant.qty}</span>`).join('')}
      </div>
    </div>
  `;

  const pendingBlock = pendingOrders.length===0 ? '' : `
    <div class="alert-banner" style="background: linear-gradient(160deg, #e6edfb, #dbe6fa);">
      <div class="alert-title" style="color:var(--navy-2);">📦 มีสินค้ารอรับของ ${pendingOrders.length} รายการ (จ่ายเงินแล้ว ยังไม่เข้าสต็อก)</div>
      <div class="alert-list">
        ${pendingOrders.map(po=>`<span class="alert-chip" style="color:var(--navy-2);">${escapeHtml(pendingLabel(po))} x${po.qty}</span>`).join('')}
      </div>
    </div>
  `;

  const groupHtml = groups.map(({prod, variants})=>{
    const totalQty = prod.variants.reduce((s,v)=>s+v.qty,0);
    const rows = variants.map(v=>{
      const isLow = v.type==='new' && v.qty>0 && v.qty<=LOW_STOCK_THRESHOLD;
      const parts = [];
      if(v.size) parts.push('ไซส์ '+escapeHtml(v.size));
      if(v.color) parts.push(escapeHtml(v.color));
      parts.push(v.type==='used' ? 'มือ2' : 'มือ1');
      return `
        <div class="variant-row ${v.qty<=0?'out':''} ${isLow?'low':''}">
          <div class="variant-info">${parts.join(' · ')}</div>
          <div class="variant-qty">${v.qty}</div>
          <button class="btn btn-ghost btn-sm" data-stats="${v.id}">สถิติ</button>
        </div>
      `;
    }).join('');
    return `
      <div class="prod-group">
        <div class="prod-group-head">
          <div class="thumb" style="width:44px;height:44px;">${prod.image ? `<img src="${prod.image}" alt="">` : '<span class="thumb-ph">👕</span>'}</div>
          <div class="prod-group-name">${escapeHtml(prod.name)}</div>
          <div class="prod-group-total">รวม ${totalQty} ชิ้น</div>
          <button class="btn btn-gold btn-sm" data-aggstats="${prod.id}">สถิติรวม</button>
        </div>
        ${rows}
      </div>
    `;
  }).join('');

  return `
    <div class="panel">
      ${alertBlock}
      ${pendingBlock}
      <h2>สต็อกสินค้าทั้งหมด</h2>
      <div class="field" style="margin-bottom:14px;">
        <input type="text" id="home-search" placeholder="ค้นหาชื่อ, สี, ไซส์..." value="${escapeHtml(stockSearch)}">
      </div>
      ${groups.length===0 ? `
        <div class="empty">
          <div class="big">${products.length===0 ? 'ยังไม่มีสินค้าในสต็อก' : 'ไม่พบสินค้าที่ค้นหา'}</div>
        </div>` : `<div class="home-list">${groupHtml}</div>`}
    </div>
  `;
}

function wireHomeTab(){
  const search = document.getElementById('home-search');
  if(search){
    search.oninput = ()=>{ stockSearch = search.value; render(); };
    search.focus();
    const len = search.value.length;
    search.setSelectionRange(len, len);
  }
  document.querySelectorAll('[data-stats]').forEach(btn=>{
    btn.onclick = ()=> openVariantDetail(btn.dataset.stats);
  });
  document.querySelectorAll('[data-aggstats]').forEach(btn=>{
    btn.onclick = ()=> openProductAggDetail(btn.dataset.aggstats);
  });
}

function renderMonthTable(months){
  if(months.length===0) return '<p class="hint" style="margin-top:14px;">ยังไม่มีประวัติการขาย</p>';
  const rows = months.map(m=>`
    <tr><td>${monthLabel(m.key)}</td><td class="num">${m.qty}</td><td class="num" style="color:${m.profit<0?'var(--red)':'var(--green)'}">${fmtMoney(m.profit)}</td></tr>
  `).join('');
  return `
    <p class="hint" style="margin-top:16px;">กำไรแยกรายเดือน</p>
    <table>
      <thead><tr><th>เดือน</th><th class="num">จำนวนที่ขาย</th><th class="num">กำไร</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function openVariantDetail(variantId){
  const found = findVariant(variantId);
  if(!found) return;
  const {product, variant} = found;
  const s = variantStats(variantId);
  document.getElementById('detail-body').innerHTML = `
    <div style="display:flex; gap:14px; align-items:center; margin-bottom:16px;">
      <div class="thumb" style="width:60px;height:60px;">${product.image ? `<img src="${product.image}" alt="">` : '<span class="thumb-ph" style="font-size:24px;">👕</span>'}</div>
      <div>
        <div style="font-family:'Baloo 2',sans-serif; font-weight:700; font-size:17px; color:var(--navy);">${escapeHtml(product.name)}</div>
        <div style="font-size:12.5px; color:var(--ink-soft); font-weight:600;">${escapeHtml(variantLabel(product,variant))} · คงเหลือ ${variant.qty}</div>
      </div>
    </div>
    <div class="detail-stats">
      <div class="detail-stat"><div class="lbl">ขายไปแล้วทั้งหมด</div><div class="val">${s.totalQtySold} ชิ้น</div></div>
      <div class="detail-stat"><div class="lbl">กำไรรวม (All time)</div><div class="val" style="color:${s.totalProfit<0?'var(--red)':'var(--green)'}">${fmtMoney(s.totalProfit)}</div></div>
    </div>
    ${renderMonthTable(s.months)}
  `;
  document.getElementById('detail-overlay').classList.add('show');
}

function openProductAggDetail(productId){
  const prod = products.find(p=>p.id===productId);
  if(!prod) return;
  const s = productAggregateStats(productId);
  const totalQty = prod.variants.reduce((sum,v)=>sum+v.qty,0);
  document.getElementById('detail-body').innerHTML = `
    <div style="display:flex; gap:14px; align-items:center; margin-bottom:16px;">
      <div class="thumb" style="width:60px;height:60px;">${prod.image ? `<img src="${prod.image}" alt="">` : '<span class="thumb-ph" style="font-size:24px;">👕</span>'}</div>
      <div>
        <div style="font-family:'Baloo 2',sans-serif; font-weight:700; font-size:17px; color:var(--navy);">${escapeHtml(prod.name)}</div>
        <div style="font-size:12.5px; color:var(--ink-soft); font-weight:600;">รวมทุกสี/ไซส์ · คงเหลือ ${totalQty} ชิ้น</div>
      </div>
    </div>
    <div class="detail-stats">
      <div class="detail-stat"><div class="lbl">ขายไปแล้วทั้งหมด (ทุกสี/ไซส์)</div><div class="val">${s.totalQtySold} ชิ้น</div></div>
      <div class="detail-stat"><div class="lbl">กำไรรวม (All time)</div><div class="val" style="color:${s.totalProfit<0?'var(--red)':'var(--green)'}">${fmtMoney(s.totalProfit)}</div></div>
    </div>
    ${renderMonthTable(s.months)}
  `;
  document.getElementById('detail-overlay').classList.add('show');
}
function closeDetail(){ document.getElementById('detail-overlay').classList.remove('show'); }

// ---------- Edit modal ----------
function openEdit(variantId){
  const found = findVariant(variantId);
  if(!found) return;
  editingVariantId = variantId;
  const {product, variant} = found;
  const f = document.getElementById('edit-form');
  f.name.value = product.name;
  f.color.value = variant.color||'';
  f.size.value = variant.size||'';
  f.querySelectorAll('input[name="type"]').forEach(r=> r.checked = (r.value===variant.type));
  f.cost.value = variant.cost;
  f.price.value = variant.price;
  f.qty.value = variant.qty;
  f.image.value = '';
  document.getElementById('edit-overlay').classList.add('show');
}
function closeEdit(){
  editingVariantId = null;
  document.getElementById('edit-overlay').classList.remove('show');
}
document.getElementById('edit-form').onsubmit = async (e)=>{
  e.preventDefault();
  if(!editingVariantId) return;
  const f = e.target;
  const fd = new FormData(f);
  let image = null;
  const file = fd.get('image');
  if(file && file.size > 0){
    try{ image = await resizeImageFile(file); }
    catch(err){ console.error('image resize failed', err); }
  }
  const name = fd.get('name').trim();
  if(!name){ showAlert('กรุณาระบุชื่อสินค้า'); return; }
  await editVariant(editingVariantId, {
    name,
    color: (fd.get('color')||'').trim(),
    size: (fd.get('size')||'').trim(),
    type: fd.get('type'),
    cost: parseFloat(fd.get('cost')),
    price: parseFloat(fd.get('price')),
    qty: parseInt(fd.get('qty'),10),
    image
  });
  closeEdit();
};

// ---------- Stock tab ----------
function pendingRowTemplate(idx){
  return `
    <div class="pending-row">
      <div class="pending-row-grid">
        <input type="text" class="pRowName" list="product-name-list" placeholder="ชื่อสินค้า">
        <input type="text" class="pRowColor" placeholder="สี">
        <input type="text" class="pRowSize" placeholder="ไซส์">
        <div class="type-toggle pending-row-type">
          <label><input type="radio" name="pType_${idx}" value="new" checked><span>มือ1</span></label>
          <label><input type="radio" name="pType_${idx}" value="used"><span>มือ2</span></label>
        </div>
        <input type="number" class="pRowQty" min="1" placeholder="จำนวน">
        <input type="number" class="pRowCost" min="0" step="0.01" placeholder="ต้นทุน/ชิ้น">
        <input type="number" class="pRowPrice" min="0" step="0.01" placeholder="ราคาที่ตั้งใจขาย (โน้ต)">
        <button type="button" class="btn-danger remove-pending-row" style="display:none;">×</button>
      </div>
    </div>
  `;
}

function renderStockTab(){
  const rows = allVariants().map(({product:p, variant:v}) => `
    <tr>
      <td><div class="thumb-cell">
        <div class="thumb">${p.image ? `<img src="${p.image}" alt="">` : '<span class="thumb-ph">👕</span>'}</div>
      </div></td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(v.size||'-')}</td>
      <td>${escapeHtml(v.color||'-')}</td>
      <td><span class="tag ${v.type}">${v.type==='new'?'มือ1':'มือ2'}</span></td>
      <td class="num">${fmtMoney(v.cost)}</td>
      <td class="num">${fmtMoney(v.price)}</td>
      <td class="num">${v.qty}</td>
      <td class="num">${fmtMoney(v.cost*v.qty)}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" data-edit="${v.id}">แก้ไข</button>
        <button class="btn-danger" data-del="${v.id}">ลบ</button>
      </td>
    </tr>
  `).join('');

  const productNameOptions = products.map(p => `<option value="${escapeHtml(p.name)}">`).join('');

  const variantOptions = allVariants().map(({product:p, variant:v}) =>
    `<option value="${v.id}">${escapeHtml(variantLabel(p,v))} — คงเหลือ ${v.qty}</option>`
  ).join('');

  return `
    <div class="panel">
      <h2>เพิ่มสินค้าเข้าสต็อก</h2>
      <form id="add-product-form">
        <div class="type-toggle" id="mode-toggle" style="max-width:520px; margin-bottom:16px;">
          <label><input type="radio" name="mode" value="new" checked><span>เพิ่มสินค้า/ตัวเลือกใหม่</span></label>
          <label><input type="radio" name="mode" value="restock" ${allVariants().length===0?'disabled':''}><span>เติมสต็อกตัวที่มีอยู่</span></label>
          <label><input type="radio" name="mode" value="pending"><span>สั่งซื้อ (จ่ายแล้ว รอของมาส่ง)</span></label>
        </div>

        <div id="new-item-fields" class="form-grid">
          <div class="field" style="grid-column:span 2">
            <label>ชื่อสินค้า</label>
            <input type="text" name="name" list="product-name-list" placeholder="เช่น เสื้อยืดลายกราฟฟิก">
            <datalist id="product-name-list">${productNameOptions}</datalist>
          </div>
          <div class="field" style="grid-column:span 2">
            <label>รูปสินค้า (ถ้ามี)</label>
            <input type="file" name="image" accept="image/*">
          </div>
          <div class="field">
            <label>ประเภทสินค้า</label>
            <div class="type-toggle">
              <label><input type="radio" name="type" value="new" checked><span>มือ1</span></label>
              <label><input type="radio" name="type" value="used"><span>มือ2</span></label>
            </div>
          </div>
          <div class="field" style="grid-column:span 2">
            <label>สี ไซส์ และจำนวน (เพิ่มได้หลายสี/หลายไซส์ในครั้งเดียว)</label>
            <div id="size-rows">
              <div class="size-row">
                <input type="text" name="colorRow" placeholder="สี เช่น ดำ">
                <input type="text" name="sizeRow" placeholder="ไซส์ เช่น S">
                <input type="number" name="qtyRow" min="1" placeholder="จำนวน">
                <button type="button" class="btn-danger remove-size-row" style="display:none;">×</button>
              </div>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" id="add-size-row" style="margin-top:4px;">+ เพิ่มแถวสี/ไซส์อีก</button>
          </div>
          <div class="field">
            <label>วิธีคิดต้นทุน</label>
            <div class="type-toggle" id="cost-mode-toggle">
              <label><input type="radio" name="costMode" value="perunit" checked><span>ต่อชิ้น</span></label>
              <label><input type="radio" name="costMode" value="lump"><span>เหมาทั้งล็อต</span></label>
            </div>
          </div>
          <div class="field" id="cost-perunit-field">
            <label>ราคาต้นทุน/ชิ้น</label>
            <input type="number" name="cost" min="0" step="0.01">
          </div>
          <div class="field" id="cost-lump-field" style="display:none;">
            <label>ยอดที่จ่ายทั้งล็อต (ทุกไซส์รวมกัน)</label>
            <input type="number" name="lumpCost" min="0" step="0.01">
          </div>
          <div class="field">
            <label>ราคาที่ตั้งใจขาย (โน้ต)</label>
            <input type="number" name="price" min="0" step="0.01">
          </div>
          <div class="field">
            <label>ค่าส่งจากต้นทาง (ครั้งนี้)</label>
            <input type="number" name="shippingIn" min="0" step="0.01" value="0">
          </div>
          <div class="checkline">
            <input type="checkbox" name="logExpense" id="logExpense" checked>
            <label for="logExpense">บันทึกต้นทุนที่ซื้อเข้าเป็นรายจ่ายทันที</label>
          </div>
          <p class="hint" style="grid-column:1/-1; margin:2px 0 0;">พิมพ์ชื่อสินค้าที่มีอยู่แล้ว ระบบจะเพิ่มเป็นตัวเลือกสี/ไซส์ใหม่ของสินค้านั้นให้อัตโนมัติ — ถ้าจ่ายเหมาทั้งล็อต ระบบจะหารเฉลี่ยต้นทุนต่อชิ้นให้เอง — "ราคาที่ตั้งใจขาย" เป็นแค่โน้ต ราคาขายจริงใส่ตอนกดขายในแท็บ "ขายสินค้า"</p>
        </div>

        <div id="restock-fields" class="form-grid" style="display:none;">
          <div class="field" style="grid-column:span 2">
            <label>เลือกสินค้าเดิม</label>
            <select name="variantId">${variantOptions}</select>
          </div>
          <div class="field">
            <label>จำนวนที่เติม (ชิ้น)</label>
            <input type="number" name="restockQty" min="1" value="1">
          </div>
          <div class="field">
            <label>ราคาต้นทุนล็อตนี้/ชิ้น</label>
            <input type="number" name="restockCost" min="0" step="0.01">
          </div>
          <div class="field">
            <label>ราคาที่ตั้งใจขาย/ชิ้น (โน้ต, แก้ไขได้)</label>
            <input type="number" name="restockPrice" min="0" step="0.01">
          </div>
          <div class="field">
            <label>ค่าส่งจากต้นทาง (ครั้งนี้)</label>
            <input type="number" name="restockShippingIn" min="0" step="0.01" value="0">
          </div>
          <div class="checkline">
            <input type="checkbox" name="restockLogExpense" id="restockLogExpense" checked>
            <label for="restockLogExpense">บันทึกต้นทุนที่เติมเข้าเป็นรายจ่ายทันที</label>
          </div>
          <p class="hint" style="grid-column:1/-1; margin:2px 0 0;">ถ้าต้นทุนล็อตนี้ไม่เท่าของเดิม ระบบจะคำนวณ "ต้นทุนเฉลี่ยถ่วงน้ำหนัก" ของสต็อกที่เหลือให้อัตโนมัติ ค่าส่งจะถูกบันทึกเป็นรายจ่ายแยกต่างหาก ไม่รวมในต้นทุนต่อชิ้น</p>
        </div>

        <div id="pending-fields" class="form-grid" style="display:none;">
          <div class="field" style="grid-column:1/-1">
            <label>วิธีคิดต้นทุน</label>
            <div class="type-toggle" id="pending-cost-mode-toggle">
              <label><input type="radio" name="pendingCostMode" value="perunit" checked><span>ต่อชิ้น (ใส่ในแต่ละแถว)</span></label>
              <label><input type="radio" name="pendingCostMode" value="lump"><span>เหมาทั้งล็อต (ยอดเดียวทั้งออเดอร์)</span></label>
            </div>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label>รายการสินค้าที่สั่ง (เพิ่มได้หลายสี/หลายสินค้าในออเดอร์เดียวกัน)</label>
            <div id="pending-rows">${pendingRowTemplate(0)}</div>
            <button type="button" class="btn btn-ghost btn-sm" id="add-pending-row" style="margin-top:6px;">+ เพิ่มรายการสินค้า</button>
          </div>
          <div class="field" id="pending-lump-field" style="display:none; grid-column:span 2;">
            <label>ยอดที่จ่ายทั้งหมด (ทุกรายการในออเดอร์นี้รวมกัน)</label>
            <input type="number" name="pendingLumpCost" min="0" step="0.01">
          </div>
          <div class="field" style="grid-column:span 2">
            <label>บันทึกเพิ่มเติม (เช่น เลขคำสั่งซื้อ, ร้านที่สั่ง) — ใช้ร่วมทั้งออเดอร์</label>
            <input type="text" name="pendingNote" placeholder="ไม่บังคับ">
          </div>
          <p class="hint" style="grid-column:1/-1; margin:2px 0 0;">ใช้ตอนโอนเงินจ่ายค่าสินค้าไปแล้วแต่ของยังไม่ถึงร้าน ระบบจะรวมยอดทุกรายการเป็นรายจ่าย 1 ก้อนทันที แต่ยัง<strong>ไม่เพิ่มเข้าสต็อก</strong>จนกว่าจะกด "ยืนยันได้รับของแล้ว" ทีละรายการ — ถ้าเลือก "เหมาทั้งล็อต" ระบบจะหารเฉลี่ยต้นทุนต่อชิ้นตามสัดส่วนจำนวนให้เอง — ค่าส่งจะยังไม่ถูกบันทึก จนกว่าจะจ่ายจริงตอนได้รับของ</p>
        </div>

        <div style="margin-top:12px;"><button type="submit" class="btn btn-primary" id="add-product-submit">เพิ่มสินค้า</button></div>
      </form>
    </div>

    <div class="panel">
      <h2>สินค้าที่สั่งซื้อแล้ว รอรับของ${pendingOrders.length>0 ? ' ('+pendingOrders.length+')' : ''}</h2>
      <p class="hint">รายการนี้จ่ายเงินไปแล้ว (นับเป็นรายจ่ายแล้ว) แต่ยังไม่นับเป็นสต็อกที่ขายได้ จนกว่าจะกดยืนยันว่าได้รับของจริง</p>
      ${pendingOrders.length===0 ? `<div class="empty"><div class="big">ไม่มีรายการรอรับของ</div></div>` : `
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${pendingOrders.map(po => `
          <div class="variant-row" style="align-items:center;">
            <div class="thumb" style="width:36px;height:36px;">${po.image ? `<img src="${po.image}" alt="">` : '<span class="thumb-ph">📦</span>'}</div>
            <div class="variant-info">
              ${escapeHtml(pendingLabel(po))} x${po.qty}<br>
              <span class="hint" style="margin:0;">สั่งเมื่อ ${po.orderDate} · จ่ายไปแล้ว ${fmtMoney(po.cost*po.qty)}${po.note ? ' · '+escapeHtml(po.note) : ''}</span>
            </div>
            <input type="number" min="0" step="0.01" value="0" class="pending-ship-input" id="pendingship-${po.id}" placeholder="ค่าส่ง" style="width:80px; padding:6px; border:none; border-radius:10px; background:var(--surface); box-shadow: inset 2px 2px 5px var(--sh-d), inset -2px -2px 5px var(--sh-l); text-align:center; font-family:'IBM Plex Mono',monospace;">
            <button class="btn btn-gold btn-sm" data-receive="${po.id}">ยืนยันได้รับของแล้ว</button>
            <button class="btn-danger" data-cancel-pending="${po.id}">ยกเลิก</button>
          </div>
        `).join('')}
      </div>`}
    </div>

    <div class="panel">
      <h2>แนบค่าส่งให้สินค้าหลายชิ้น</h2>
      <p class="hint">ใช้ตอนจ่ายค่าส่งเหมาทั้งล็อตให้หลายสินค้าพร้อมกัน (ไม่ต้องแยกจ่ายรายชิ้น) เลือกสินค้าที่มาในล็อตนี้พร้อมจำนวน แล้วใส่ยอดค่าส่งรวม ระบบจะบันทึกเป็นรายจ่าย 1 รายการ แนบไว้กับสินค้าที่เลือกทั้งหมด</p>
      <div class="field" style="margin-bottom:10px;">
        <input type="text" id="attach-ship-search" placeholder="ค้นหาสินค้าที่จะแนบ...">
      </div>
      ${allVariants().length===0 ? `<div class="empty"><div class="big">ยังไม่มีสินค้าในสต็อกให้แนบค่าส่ง</div></div>` : `
      <div id="attach-ship-list" style="max-height:280px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
        ${allVariants().map(({product:p, variant:v}) => `
          <div class="variant-row" data-attach-row="${v.id}" data-attach-label="${escapeHtml(variantLabel(p,v)).toLowerCase()}">
            <div class="variant-info">${escapeHtml(variantLabel(p,v))} (คงเหลือ ${v.qty})</div>
            <input type="number" min="0" max="${v.qty}" value="0" class="attach-qty" data-variant="${v.id}" style="width:70px; padding:6px; border:none; border-radius:10px; background:var(--surface); box-shadow: inset 2px 2px 5px var(--sh-d), inset -2px -2px 5px var(--sh-l); text-align:center; font-family:'IBM Plex Mono',monospace;">
          </div>
        `).join('')}
      </div>
      <div class="form-grid" style="margin-top:14px; grid-template-columns:1fr 1fr;">
        <div class="field">
          <label>ยอดค่าส่งรวมทั้งหมด</label>
          <input type="number" id="attach-ship-amount" min="0" step="0.01">
        </div>
        <div class="field">
          <label>วันที่</label>
          <input type="date" id="attach-ship-date" value="${todayStr()}">
        </div>
      </div>
      <div style="margin-top:12px;"><button class="btn btn-primary" id="attach-ship-submit">บันทึกค่าส่ง</button></div>
      `}
    </div>

    <div class="panel">
      <h2>รายการสินค้าในสต็อก</h2>
      ${allVariants().length===0 ? `
        <div class="empty">
          <div class="big">ยังไม่มีสินค้าในสต็อก</div>
          เพิ่มสินค้าชิ้นแรกจากฟอร์มด้านบน
        </div>` : `
        <table>
          <thead><tr>
            <th></th><th>ชื่อสินค้า</th><th>ไซส์</th><th>สี</th><th>ประเภท</th><th class="num">ต้นทุน</th><th class="num">ราคาที่ตั้งใจขาย</th>
            <th class="num">คงเหลือ</th><th class="num">มูลค่าคงเหลือ</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
    </div>
  `;
}

function wireStockTab(){
  const f = document.getElementById('add-product-form');
  const newFields = document.getElementById('new-item-fields');
  const restockFields = document.getElementById('restock-fields');
  const pendingFields = document.getElementById('pending-fields');
  const submitBtn = document.getElementById('add-product-submit');
  const modeToggle = document.getElementById('mode-toggle');
  const restockSelect = f ? f.querySelector('[name="variantId"]') : null;
  const restockCost = f ? f.querySelector('[name="restockCost"]') : null;
  const restockPrice = f ? f.querySelector('[name="restockPrice"]') : null;

  function syncRestockPrefill(){
    if(!restockSelect) return;
    const found = findVariant(restockSelect.value);
    if(found){
      restockCost.value = found.variant.cost;
      restockPrice.value = found.variant.price;
    }
  }

  if(modeToggle){
    modeToggle.querySelectorAll('input[name="mode"]').forEach(r=>{
      r.onchange = ()=>{
        if(r.checked){
          newFields.style.display = r.value==='new' ? 'grid' : 'none';
          restockFields.style.display = r.value==='restock' ? 'grid' : 'none';
          pendingFields.style.display = r.value==='pending' ? 'grid' : 'none';
          submitBtn.textContent = r.value==='restock' ? 'เติมสต็อก' : (r.value==='pending' ? 'บันทึกรายการสั่งซื้อ' : 'เพิ่มสินค้า');
          if(r.value==='restock') syncRestockPrefill();
        }
      };
    });
    wireToggleLabels(modeToggle);
  }
  if(restockSelect) restockSelect.onchange = syncRestockPrefill;
  syncRestockPrefill();

  // robust click handling for all other type-toggle radio groups on this tab
  // (ประเภทสินค้า in new-item-fields / pending-fields, and cost-mode-toggle)
  document.querySelectorAll('#new-item-fields .type-toggle, #pending-fields .type-toggle, #cost-mode-toggle').forEach(wireToggleLabels);

  // --- size rows (add/remove) ---
  function wireRemoveButtons(){
    const rowsDiv = document.getElementById('size-rows');
    const buttons = rowsDiv.querySelectorAll('.remove-size-row');
    buttons.forEach(btn=>{
      btn.style.display = buttons.length>1 ? 'inline-flex' : 'none';
      btn.onclick = ()=>{
        if(rowsDiv.children.length>1) btn.closest('.size-row').remove();
        wireRemoveButtons();
      };
    });
  }
  const addSizeBtn = document.getElementById('add-size-row');
  if(addSizeBtn){
    addSizeBtn.onclick = ()=>{
      const rowsDiv = document.getElementById('size-rows');
      const row = document.createElement('div');
      row.className = 'size-row';
      row.innerHTML = `
        <input type="text" name="colorRow" placeholder="สี เช่น ขาว">
        <input type="text" name="sizeRow" placeholder="ไซส์ เช่น M">
        <input type="number" name="qtyRow" min="1" placeholder="จำนวน">
        <button type="button" class="btn-danger remove-size-row">×</button>
      `;
      rowsDiv.appendChild(row);
      wireRemoveButtons();
    };
    wireRemoveButtons();
  }

  // --- pending order rows (add/remove) ---
  let pendingRowSeq = 1;
  function wirePendingRemoveButtons(){
    const rowsDiv = document.getElementById('pending-rows');
    if(!rowsDiv) return;
    const buttons = rowsDiv.querySelectorAll('.remove-pending-row');
    buttons.forEach(btn=>{
      btn.style.display = buttons.length>1 ? 'inline-flex' : 'none';
      btn.onclick = ()=>{
        if(rowsDiv.children.length>1) btn.closest('.pending-row').remove();
        wirePendingRemoveButtons();
      };
    });
  }
  const addPendingRowBtn = document.getElementById('add-pending-row');
  if(addPendingRowBtn){
    addPendingRowBtn.onclick = ()=>{
      const rowsDiv = document.getElementById('pending-rows');
      const wrapper = document.createElement('div');
      wrapper.innerHTML = pendingRowTemplate(pendingRowSeq++);
      const newRow = wrapper.firstElementChild;
      rowsDiv.appendChild(newRow);
      wireToggleLabels(newRow.querySelector('.pending-row-type'));
      wirePendingRemoveButtons();
    };
    wirePendingRemoveButtons();
  }

  // --- pending order cost mode toggle (per-unit vs lump sum for whole order) ---
  const pendingCostModeToggle = document.getElementById('pending-cost-mode-toggle');
  const pendingLumpField = document.getElementById('pending-lump-field');
  const pendingRowsDiv = document.getElementById('pending-rows');
  if(pendingCostModeToggle){
    pendingCostModeToggle.querySelectorAll('input[name="pendingCostMode"]').forEach(r=>{
      r.onchange = ()=>{
        if(r.checked){
          const isLump = r.value==='lump';
          pendingLumpField.style.display = isLump ? 'flex' : 'none';
          if(pendingRowsDiv) pendingRowsDiv.classList.toggle('lump-mode', isLump);
        }
      };
    });
  }

  // --- cost mode toggle ---
  const costModeToggle = document.getElementById('cost-mode-toggle');
  const costPerunitField = document.getElementById('cost-perunit-field');
  const costLumpField = document.getElementById('cost-lump-field');
  if(costModeToggle){
    costModeToggle.querySelectorAll('input[name="costMode"]').forEach(r=>{
      r.onchange = ()=>{
        if(r.checked){
          const isLump = r.value==='lump';
          costPerunitField.style.display = isLump ? 'none' : 'flex';
          costLumpField.style.display = isLump ? 'flex' : 'none';
        }
      };
    });
  }

  if(f) f.onsubmit = async (e)=>{
    e.preventDefault();
    try{
    const fd = new FormData(f);
    const mode = fd.get('mode');
    if(mode==='restock'){
      const variantId = fd.get('variantId');
      if(!variantId){ showAlert('กรุณาเลือกสินค้าที่ต้องการเติมสต็อก'); return; }
      const qty = parseInt(fd.get('restockQty'),10);
      if(!qty || qty<1){ showAlert('ระบุจำนวนที่จะเติมให้ถูกต้อง'); return; }
      restockVariant(variantId, {
        qty,
        cost: fd.get('restockCost') !== '' ? parseFloat(fd.get('restockCost')) : null,
        price: fd.get('restockPrice') !== '' ? parseFloat(fd.get('restockPrice')) : null,
        logExpense: fd.get('restockLogExpense') === 'on',
        shippingIn: parseFloat(fd.get('restockShippingIn'))||0
      });
    }else if(mode==='pending'){
      const pendingCostMode = fd.get('pendingCostMode') || 'perunit';
      const rowEls = document.querySelectorAll('#pending-rows .pending-row');
      const rows = [];
      let rowError = null;
      rowEls.forEach((rowEl, i)=>{
        const name = rowEl.querySelector('.pRowName').value.trim();
        const qtyStr = rowEl.querySelector('.pRowQty').value;
        const costStr = rowEl.querySelector('.pRowCost').value;
        if(!name && !qtyStr && !costStr) return; // skip fully-empty rows
        const qty = parseInt(qtyStr,10);
        const priceVal = parseFloat(rowEl.querySelector('.pRowPrice').value);
        const typeInput = rowEl.querySelector('.pending-row-type input:checked');
        if(!name){ rowError = 'กรุณาระบุชื่อสินค้าในแถวที่ ' + (i+1); return; }
        if(!qty || qty<1){ rowError = 'ระบุจำนวนให้ถูกต้องในแถวที่ ' + (i+1); return; }
        let cost = null;
        if(pendingCostMode !== 'lump'){
          cost = parseFloat(costStr);
          if(isNaN(cost) || cost<0){ rowError = 'กรุณาระบุราคาต้นทุนในแถวที่ ' + (i+1); return; }
        }
        rows.push({
          name,
          color: rowEl.querySelector('.pRowColor').value.trim(),
          size: rowEl.querySelector('.pRowSize').value.trim(),
          type: typeInput ? typeInput.value : 'new',
          qty, cost,
          price: isNaN(priceVal) ? 0 : priceVal
        });
      });
      if(rowError){ showAlert(rowError); return; }
      if(rows.length===0){ showAlert('กรุณาเพิ่มรายการสินค้าที่สั่งซื้ออย่างน้อย 1 รายการ'); return; }
      if(pendingCostMode === 'lump'){
        const lumpTotal = parseFloat(fd.get('pendingLumpCost'));
        if(!lumpTotal || lumpTotal<=0){ showAlert('กรุณาระบุยอดที่จ่ายทั้งล็อต'); return; }
        const totalQty = rows.reduce((s,r)=>s+r.qty,0);
        const unitCost = lumpTotal/totalQty;
        rows.forEach(r=> r.cost = unitCost);
      }
      addPendingOrderBatch(rows, fd.get('pendingNote')||'');
    }else{
      const name = (fd.get('name')||'').trim();
      if(!name){ showAlert('กรุณาระบุชื่อสินค้า'); return; }

      const colorVals = fd.getAll('colorRow');
      const sizeVals = fd.getAll('sizeRow');
      const qtyVals = fd.getAll('qtyRow');
      const rowsRaw = sizeVals.map((s,i)=>({ color:(colorVals[i]||'').trim(), size:(s||'').trim(), qty: parseInt(qtyVals[i],10)||0 })).filter(r=>r.qty>0);
      if(rowsRaw.length===0){ showAlert('กรุณาระบุสี/ไซส์และจำนวนอย่างน้อย 1 รายการ'); return; }
      const totalQty = rowsRaw.reduce((s,r)=>s+r.qty,0);

      const costMode = fd.get('costMode');
      let unitCost;
      if(costMode==='lump'){
        const lump = parseFloat(fd.get('lumpCost'));
        if(!lump || lump<=0){ showAlert('กรุณาระบุยอดที่จ่ายทั้งล็อต'); return; }
        unitCost = lump/totalQty;
      }else{
        unitCost = parseFloat(fd.get('cost'));
        if(isNaN(unitCost) || unitCost<0){ showAlert('กรุณาระบุราคาต้นทุนต่อชิ้น'); return; }
      }

      let image = null;
      const file = fd.get('image');
      if(file && file.size > 0){
        try{ image = await resizeImageFile(file); }
        catch(err){ console.error('image resize failed', err); }
      }

      const priceVal = parseFloat(fd.get('price'));
      if(isNaN(priceVal) || priceVal<0){ showAlert('กรุณาระบุราคาที่ตั้งใจขาย'); return; }

      const base = {
        name,
        type: fd.get('type'),
        price: priceVal,
        image,
        logExpense: fd.get('logExpense') === 'on',
        shippingIn: parseFloat(fd.get('shippingIn'))||0
      };
      const rows = rowsRaw.map(r => ({ color: r.color, size: r.size, qty: r.qty, cost: unitCost }));
      addProductBatch(base, rows);
    }
    }catch(err){
      console.error('add-product-form submit failed', err);
      showAlert('เกิดข้อผิดพลาดที่ไม่คาดคิด: ' + (err && err.message ? err.message : err));
    }
  };
  document.querySelectorAll('[data-del]').forEach(btn=>{
    btn.onclick = ()=> deleteVariant(btn.dataset.del);
  });
  document.querySelectorAll('[data-edit]').forEach(btn=>{
    btn.onclick = ()=> openEdit(btn.dataset.edit);
  });
  document.querySelectorAll('[data-receive]').forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.dataset.receive;
      const shipInput = document.getElementById('pendingship-'+id);
      receivePendingOrder(id, shipInput ? shipInput.value : 0);
    };
  });
  document.querySelectorAll('[data-cancel-pending]').forEach(btn=>{
    btn.onclick = ()=> deletePendingOrder(btn.dataset.cancelPending);
  });

  // --- bulk attach shipping ---
  const attachSearch = document.getElementById('attach-ship-search');
  if(attachSearch){
    attachSearch.oninput = ()=>{
      const q = attachSearch.value.trim().toLowerCase();
      document.querySelectorAll('[data-attach-row]').forEach(row=>{
        row.style.display = (!q || row.dataset.attachLabel.includes(q)) ? 'flex' : 'none';
      });
    };
  }
  const attachSubmit = document.getElementById('attach-ship-submit');
  if(attachSubmit){
    attachSubmit.onclick = ()=>{
      const items = [];
      document.querySelectorAll('.attach-qty').forEach(inp=>{
        const qty = parseInt(inp.value,10)||0;
        if(qty>0){
          const found = findVariant(inp.dataset.variant);
          if(found) items.push({ variantId: inp.dataset.variant, qty, label: variantLabel(found.product, found.variant) });
        }
      });
      if(items.length===0){ showAlert('กรุณาเลือกสินค้าที่จะแนบค่าส่งอย่างน้อย 1 รายการ'); return; }
      const amount = parseFloat(document.getElementById('attach-ship-amount').value);
      if(!amount || amount<=0){ showAlert('กรุณาระบุยอดค่าส่งรวมให้ถูกต้อง'); return; }
      const date = document.getElementById('attach-ship-date').value;
      attachShippingBulk(items, amount, date);
    };
  }
}

// ---------- Sell tab ----------
function renderSellTab(){
  const inStock = allVariants().filter(({variant})=>variant.qty>0);
  const cards = inStock.map(({product:p, variant:v}) => `
    <div class="sell-card">
      <div class="sell-card-top">
        <span class="tag ${v.type}">${v.type==='new'?'มือ1':'มือ2'}</span>
        <span class="sell-stock">คงเหลือ ${v.qty}</span>
      </div>
      <div style="display:flex; gap:10px; align-items:flex-start;">
        <div class="thumb" style="width:40px;height:40px;flex-shrink:0;">${p.image ? `<img src="${p.image}" alt="">` : '<span class="thumb-ph">👕</span>'}</div>
        <div style="flex:1; min-width:0;">
          <div class="sell-name">${escapeHtml(p.name)}${v.size ? ' <span class="sell-color">· ไซส์ '+escapeHtml(v.size)+'</span>' : ''}${v.color ? ' <span class="sell-color">· '+escapeHtml(v.color)+'</span>' : ''}</div>
          <div class="sell-price">${fmtMoney(v.price)} <span class="sell-cost-note">โน้ตราคา (ต้นทุน ${fmtMoney(v.cost)})</span></div>
        </div>
      </div>
      <div class="sell-form">
        <div class="field">
          <label>จำนวน</label>
          <input type="number" min="1" max="${v.qty}" value="1" id="sellqty-${v.id}">
        </div>
        <div class="field">
          <label>ราคาขายจริง/ชิ้น</label>
          <input type="number" min="0" step="0.01" value="${v.price}" id="sellprice-${v.id}">
        </div>
        <div class="field">
          <label>ค่าส่ง (รวม)</label>
          <input type="number" min="0" step="0.01" value="0" id="sellship-${v.id}">
        </div>
        <div class="field">
          <label>ค่ากลาง (รวม)</label>
          <input type="number" min="0" step="0.01" value="0" id="sellcomm-${v.id}">
        </div>
      </div>
      <button class="btn btn-gold btn-sm" style="width:100%; margin-top:10px;" data-sell="${v.id}">กดขาย</button>
      <div class="checkline" style="margin-top:10px;">
        <input type="checkbox" id="sellinst-${v.id}" data-inst-toggle="${v.id}">
        <label for="sellinst-${v.id}">ลูกค้าผ่อนชำระ (ไม่ได้เงินก้อนเดียว)</label>
      </div>
      <div class="field" id="sellduedays-wrap-${v.id}" style="display:none; margin-top:6px;">
        <label>ผ่อนชำระให้ครบภายใน (วัน)</label>
        <input type="number" min="1" value="30" id="sellduedays-${v.id}">
        <label style="margin-top:6px;">มัดจำที่ได้รับตอนนี้ (ถ้ามี)</label>
        <input type="number" min="0" step="0.01" value="0" id="selldeposit-${v.id}">
        <label style="margin-top:6px;">ชื่อลูกค้า/บันทึกเพิ่มเติม</label>
        <input type="text" placeholder="เช่น ชื่อลูกค้า, เบอร์โทร" id="sellcustomer-${v.id}">
      </div>
    </div>
  `).join('');

  const outOfStock = allVariants().filter(({variant})=>variant.qty<=0);
  const outList = outOfStock.length ? `
    <p class="hint" style="margin-top:18px;">สินค้าหมดสต็อก: ${outOfStock.map(({product,variant})=>escapeHtml(variantLabel(product,variant))).join(', ')}</p>
  ` : '';

  return `
    <div class="panel">
      <h2>กดขายสินค้า</h2>
      <p class="hint">ใส่ราคาขายจริง ค่าส่ง และค่ากลาง (ถ้ามี) แล้วกด "กดขาย" ระบบจะตัดสต็อกและบันทึกรายรับ-กำไรให้อัตโนมัติ</p>
      ${inStock.length===0 ? `
        <div class="empty">
          <div class="big">ไม่มีสินค้าพร้อมขาย</div>
          เพิ่มสินค้าในแท็บ "สต็อกสินค้า" ก่อน
        </div>` : `<div class="sell-grid">${cards}</div>`}
      ${outList}
    </div>
  `;
}

function wireSellTab(){
  document.querySelectorAll('[data-inst-toggle]').forEach(cb=>{
    cb.onchange = ()=>{
      const wrap = document.getElementById('sellduedays-wrap-'+cb.dataset.instToggle);
      if(wrap) wrap.style.display = cb.checked ? 'block' : 'none';
    };
  });
  document.querySelectorAll('[data-sell]').forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.dataset.sell;
      const instCb = document.getElementById('sellinst-'+id);
      const dueDaysEl = document.getElementById('sellduedays-'+id);
      const depositEl = document.getElementById('selldeposit-'+id);
      const customerEl = document.getElementById('sellcustomer-'+id);
      sellVariant(id, {
        qty: document.getElementById('sellqty-'+id).value,
        sellPrice: document.getElementById('sellprice-'+id).value,
        shipping: document.getElementById('sellship-'+id).value,
        commission: document.getElementById('sellcomm-'+id).value,
        installment: instCb ? instCb.checked : false,
        dueDays: dueDaysEl ? dueDaysEl.value : 30,
        deposit: depositEl ? depositEl.value : 0,
        customerNote: customerEl ? customerEl.value : ''
      });
    };
  });
}

// ---------- Installments tab ----------
function renderInstallmentsTab(){
  const all = transactions.filter(t=>t.type==='installment');
  const today = todayStr();
  const outstanding = openInstallments().sort((a,b)=> a.dueDate.localeCompare(b.dueDate));
  const settled = all.filter(t=> (t.amount - (t.paidAmount||0)) <= 0.001);

  const rowHtml = (t)=>{
    const remaining = Math.max(0, t.amount - (t.paidAmount||0));
    const overdue = remaining > 0.001 && t.dueDate < today;
    return `
      <tr class="${overdue?'overdue-row':''}">
        <td class="num" style="font-family:'IBM Plex Mono',monospace;">${t.date}</td>
        <td>${escapeHtml(t.desc||'')}</td>
        <td class="num">${fmtMoney(t.amount)}</td>
        <td class="num" style="color:var(--green);">${fmtMoney(t.paidAmount||0)}</td>
        <td class="num" style="color:${remaining>0.001?'var(--red)':'var(--green)'}; font-weight:700;">${fmtMoney(remaining)}</td>
        <td>${t.dueDate}${overdue?' <span style="color:var(--red); font-weight:700;">(เกินกำหนด)</span>':''}</td>
        <td>${remaining>0.001 ? `<button class="btn btn-gold btn-sm" data-pay="${t.id}">รับชำระเพิ่ม</button>` : '<span class="tag income">ชำระครบแล้ว</span>'}</td>
      </tr>
    `;
  };

  return `
    <div class="panel">
      <h2>ลูกหนี้ผ่อนชำระ</h2>
      <p class="hint">ยอดขายแบบผ่อนชำระจะยังไม่นับเป็น "รายรับ" จนกว่าจะได้รับเงินจริง (นับกำไร/จำนวนขายทันทีเพื่อสถิติสินค้า) ส่วนนี้ใช้ติดตามว่าใครค้างชำระอยู่เท่าไหร่และครบกำหนดเมื่อไหร่</p>
      ${outstanding.length===0 ? `<div class="empty"><div class="big">ไม่มีลูกหนี้ค้างชำระ</div></div>` : `
      <table>
        <thead><tr><th>วันที่ขาย</th><th>รายการ</th><th class="num">ยอดขาย</th><th class="num">ชำระแล้ว</th><th class="num">ค้างชำระ</th><th>ครบกำหนด</th><th></th></tr></thead>
        <tbody>${outstanding.map(rowHtml).join('')}</tbody>
      </table>`}
    </div>
    ${settled.length===0 ? '' : `
    <div class="panel">
      <h2>ผ่อนชำระครบแล้ว</h2>
      <table>
        <thead><tr><th>วันที่ขาย</th><th>รายการ</th><th class="num">ยอดขาย</th><th class="num">ชำระแล้ว</th><th class="num">ค้างชำระ</th><th>ครบกำหนด</th><th></th></tr></thead>
        <tbody>${settled.map(rowHtml).join('')}</tbody>
      </table>
    </div>`}
  `;
}

function wireInstallmentsTab(){
  document.querySelectorAll('[data-pay]').forEach(btn=>{
    btn.onclick = ()=> openPaymentModal(btn.dataset.pay);
  });
}

// ---------- Transactions tab ----------
function renderTxTab(){
  const rows = transactions.map(t => `
    <tr>
      <td class="num" style="font-family:'IBM Plex Mono',monospace;">${t.date}</td>
      <td><span class="tag ${t.type}">${t.type==='income'?'รายรับ':'รายจ่าย'}</span></td>
      <td>${escapeHtml(t.category||'')}</td>
      <td>${escapeHtml(t.desc||'')}</td>
      <td class="num" style="color:${t.type==='income'?'var(--green)':'var(--red)'}">${t.type==='income'?'+':'-'}${fmtMoney(t.amount)}</td>
      <td><button class="btn-danger" data-txdel="${t.id}">ลบ</button></td>
    </tr>
  `).join('');

  return `
    <div class="panel">
      <h2>บันทึกรายการรายรับ-รายจ่ายเพิ่มเติม</h2>
      <p class="hint">สำหรับค่าใช้จ่ายอื่นๆ ที่ไม่ใช่ต้นทุนสินค้า เช่น ค่าเช่า ค่าขนส่ง หรือรายรับอื่น</p>
      <form id="add-tx-form">
        <div class="form-grid">
          <div class="field">
            <label>ประเภท</label>
            <select name="type">
              <option value="expense">รายจ่าย</option>
              <option value="income">รายรับ</option>
            </select>
          </div>
          <div class="field">
            <label>หมวดหมู่</label>
            <input type="text" name="category" placeholder="เช่น ค่าเช่าร้าน">
          </div>
          <div class="field" style="grid-column:span 2">
            <label>รายละเอียด</label>
            <input type="text" name="desc" placeholder="รายละเอียดเพิ่มเติม">
          </div>
          <div class="field">
            <label>จำนวนเงิน (บาท)</label>
            <input type="number" name="amount" min="0" step="0.01" required>
          </div>
          <div class="field">
            <label>วันที่</label>
            <input type="date" name="date" value="${todayStr()}">
          </div>
        </div>
        <div style="margin-top:12px;"><button type="submit" class="btn btn-primary">บันทึกรายการ</button></div>
      </form>
    </div>

    <div class="panel">
      <h2>ประวัติรายการทั้งหมด</h2>
      ${transactions.length===0 ? `
        <div class="empty">
          <div class="big">ยังไม่มีรายการบัญชี</div>
          รายการจะเพิ่มอัตโนมัติเมื่อขายสินค้า หรือเพิ่มด้วยตนเองจากฟอร์มด้านบน
        </div>` : `
        <table>
          <thead><tr><th>วันที่</th><th>ประเภท</th><th>หมวดหมู่</th><th>รายละเอียด</th><th class="num">จำนวนเงิน</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
    </div>
  `;
}

function wireTxTab(){
  const f = document.getElementById('add-tx-form');
  if(f) f.onsubmit = (e)=>{
    e.preventDefault();
    const fd = new FormData(f);
    const amount = parseFloat(fd.get('amount'));
    if(!amount || amount<=0){ showAlert('ระบุจำนวนเงินให้ถูกต้อง'); return; }
    addManualTx({
      type: fd.get('type'),
      category: fd.get('category').trim(),
      desc: fd.get('desc').trim(),
      amount,
      date: fd.get('date') || todayStr()
    });
  };
  document.querySelectorAll('[data-txdel]').forEach(btn=>{
    btn.onclick = ()=> deleteTx(btn.dataset.txdel);
  });
}

// ---------- Report tab ----------
function renderReportTab(){
  const keys = Array.from(new Set(transactions.map(t=>monthKey(t.date)))).sort().reverse();
  const sales = transactions.filter(t=>t.category==='ขายสินค้า' && t.profit!=null);

  if(keys.length===0){
    return `<div class="panel"><h2>รายงานกำไรรายเดือน</h2>
      <div class="empty"><div class="big">ยังไม่มีข้อมูลสำหรับสรุปรายเดือน</div>เมื่อมีการขายสินค้าหรือบันทึกรายรับ-รายจ่าย รายงานจะแสดงที่นี่</div>
    </div>`;
  }
  const maxTotal = Math.max(...keys.map(k=>{ const s=monthSummary(k); return s.income + s.expense; }), 1);
  const rows = keys.map(k=>{
    const s = monthSummary(k);
    const inPct = (s.income/maxTotal*100).toFixed(1);
    const exPct = (s.expense/maxTotal*100).toFixed(1);
    return `
      <div class="month-row">
        <div class="month-label">${monthLabel(k)}</div>
        <div>
          <div class="bar-wrap"><div class="bar-in" style="width:${inPct}%"></div><div class="bar-ex" style="width:${exPct}%"></div></div>
          <div class="month-sub">รับ ${fmtMoney(s.income)} · จ่าย ${fmtMoney(s.expense)}</div>
        </div>
        <div class="month-profit ${s.profit<0?'neg':'pos'}">${fmtMoney(s.profit)}</div>
      </div>
    `;
  }).join('');

  const saleRows = sales.map(t => `
    <tr>
      <td class="num" style="font-family:'IBM Plex Mono',monospace;">${t.date}</td>
      <td>${escapeHtml(t.desc||'')}</td>
      <td class="num">${fmtMoney(t.unitPrice)}</td>
      <td class="num">${fmtMoney(t.unitCost)}</td>
      <td class="num">${fmtMoney(t.shipping||0)}</td>
      <td class="num">${fmtMoney(t.commission||0)}</td>
      <td class="num" style="color:${t.profit<0?'var(--red)':'var(--green)'}; font-weight:700;">${fmtMoney(t.profit)}</td>
    </tr>
  `).join('');

  const saleSection = sales.length === 0 ? '' : `
    <div class="panel">
      <h2>กำไรรายชิ้น (ตามการขายแต่ละครั้ง)</h2>
      <p class="hint">กำไรสุทธิ = (ราคาขายจริง − ต้นทุน) × จำนวน − ค่าส่ง − ค่ากลาง</p>
      <table>
        <thead><tr><th>วันที่</th><th>รายการ</th><th class="num">ราคาขาย/ชิ้น</th><th class="num">ต้นทุน/ชิ้น</th><th class="num">ค่าส่ง</th><th class="num">ค่ากลาง</th><th class="num">กำไรสุทธิ</th></tr></thead>
        <tbody>${saleRows}</tbody>
      </table>
    </div>
  `;

  const top = topSellers(5, 'qty');
  const topRows = top.map((t,i)=>`
    <tr>
      <td class="num" style="font-family:'IBM Plex Mono',monospace; font-weight:700; color:var(--navy);">#${i+1}</td>
      <td>${escapeHtml(t.name)}</td>
      <td class="num">${t.qty} ชิ้น</td>
      <td class="num" style="color:${t.profit<0?'var(--red)':'var(--green)'}; font-weight:700;">${fmtMoney(t.profit)}</td>
    </tr>
  `).join('');
  const topSection = top.length===0 ? '' : `
    <div class="panel">
      <h2>สินค้าขายดี (Top 5)</h2>
      <table>
        <thead><tr><th>อันดับ</th><th>สินค้า</th><th class="num">ขายไปแล้ว</th><th class="num">กำไรรวม</th></tr></thead>
        <tbody>${topRows}</tbody>
      </table>
    </div>
  `;

  const chartSection = `
    <div class="panel">
      <h2>กราฟแนวโน้ม 6 เดือนล่าสุด</h2>
      <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
    </div>
    <div class="panel">
      <h2>กราฟสินค้าขายดี</h2>
      <div class="chart-wrap"><canvas id="sellers-chart"></canvas></div>
    </div>
  `;

  return `<div class="panel"><h2>รายงานกำไรรายเดือน</h2><p class="hint">กำไร = รายรับทั้งหมด − รายจ่ายทั้งหมด ของแต่ละเดือน (รวมต้นทุนสินค้าที่ซื้อเข้า)</p>${rows}</div>${chartSection}${topSection}${saleSection}`;
}

let trendChartInstance = null;
let sellersChartInstance = null;
function wireReportTab(){
  if(typeof Chart === 'undefined') return;
  const trendCanvas = document.getElementById('trend-chart');
  if(trendCanvas){
    const months = last6MonthsKeys();
    const labels = months.map(monthLabel);
    const incomeData = months.map(k=>monthSummary(k).income);
    const expenseData = months.map(k=>monthSummary(k).expense);
    const profitData = months.map(k=>monthSummary(k).profit);
    if(trendChartInstance) trendChartInstance.destroy();
    trendChartInstance = new Chart(trendCanvas, {
      type:'line',
      data:{ labels, datasets:[
        {label:'รายรับ', data:incomeData, borderColor:'#1f8a5c', backgroundColor:'rgba(31,138,92,0.12)', tension:0.3, fill:true},
        {label:'รายจ่าย', data:expenseData, borderColor:'#d1435b', backgroundColor:'rgba(209,67,91,0.12)', tension:0.3, fill:true},
        {label:'กำไร', data:profitData, borderColor:'#16214a', backgroundColor:'rgba(22,33,74,0.06)', tension:0.3, borderWidth:3, fill:true}
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom', labels:{font:{family:'Nunito', weight:600}}}},
        scales:{ y:{ ticks:{ callback:v=>'฿'+Number(v).toLocaleString() } } } }
    });
  }
  const sellersCanvas = document.getElementById('sellers-chart');
  if(sellersCanvas){
    const top = topSellers(5,'qty');
    if(sellersChartInstance) sellersChartInstance.destroy();
    sellersChartInstance = new Chart(sellersCanvas, {
      type:'bar',
      data:{ labels: top.map(t=>t.name), datasets:[{ label:'จำนวนที่ขาย (ชิ้น)', data: top.map(t=>t.qty), backgroundColor:'#37448c', borderRadius:8 }] },
      options:{ responsive:true, maintainAspectRatio:false, indexAxis:'y', plugins:{legend:{display:false}} }
    });
  }
}

// Wires clicks on .type-toggle labels directly to their radio input, instead of
// relying on native label->hidden-input click forwarding (unreliable in some
// sandboxed/mobile webviews when the input is display:none).
function wireToggleLabels(container){
  if(!container) return;
  container.querySelectorAll('label').forEach(label=>{
    const input = label.querySelector('input[type="radio"]');
    if(!input) return;
    label.onclick = (e)=>{
      if(input.disabled) return;
      e.preventDefault();
      if(!input.checked){
        input.checked = true;
        input.dispatchEvent(new Event('change', {bubbles:true}));
      }
    };
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- AI trend analysis ----------
function renderAiTab(){
  return `
    <div class="panel">
      <h2>AI วิเคราะห์แนวโน้มร้านค้า</h2>
      <p class="hint">ให้ AI ช่วยวิเคราะห์ยอดขาย สินค้าขายดี สินค้าที่ควรโปรโมท และให้คำแนะนำเรื่องสต็อกจากข้อมูลร้านจริงของคุณ</p>
      <button class="btn btn-primary" id="ai-run-btn">วิเคราะห์เทรนด์ด้วย AI</button>
      <div id="ai-result"></div>
    </div>
  `;
}

function wireAiTab(){
  const btn = document.getElementById('ai-run-btn');
  if(btn) btn.onclick = runAiAnalysis;
}

async function runAiAnalysis(){
  const btn = document.getElementById('ai-run-btn');
  const resultBox = document.getElementById('ai-result');
  if(!btn || !resultBox) return;
  if(transactions.filter(t=>t.category==='ขายสินค้า').length===0){
    resultBox.innerHTML = '<div class="ai-result">ยังไม่มีประวัติการขาย ลองขายสินค้าสักสองสามรายการก่อน แล้วค่อยกลับมาวิเคราะห์นะครับ</div>';
    return;
  }
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'กำลังวิเคราะห์...';
  resultBox.innerHTML = '<div class="ai-result">กำลังประมวลผลข้อมูลร้านของคุณ รอสักครู่...</div>';
  try{
    const months = last6MonthsKeys();
    const monthlyData = months.map(k=>({ month: monthLabel(k), ...monthSummary(k) }));
    const sellersByQty = topSellers(8, 'qty');
    const sellersByProfit = topSellers(8, 'profit');
    const lowStock = lowStockVariants().map(({product,variant})=>variantLabel(product,variant));
    const payload = {
      monthlyData, sellersByQty, sellersByProfit, lowStockItems: lowStock,
      totalProducts: products.length, totalVariants: allVariants().length, currentStockValue: stockValue()
    };
    const prompt = 'คุณเป็นที่ปรึกษาธุรกิจร้านเสื้อผ้ามือหนึ่ง/มือสอง วิเคราะห์ข้อมูลยอดขายและสต็อกของร้าน "Crazsix Store" ต่อไปนี้ แล้วสรุปเป็นภาษาไทย กระชับ เป็นข้อๆ (bullet) ครอบคลุม 5 หัวข้อ: 1) แนวโน้มยอดขาย/กำไรช่วงที่ผ่านมา 2) สินค้าขายดีที่ควรเน้นสต็อกเพิ่ม 3) สินค้าที่กำไรดีแต่อาจขายช้า (โอกาสปรับราคา/โปรโมท) 4) คำแนะนำเรื่องสต็อกใกล้หมด 5) คำแนะนำอื่นที่เป็นประโยชน์ ตอบไม่เกิน 300 คำ ห้ามใช้ markdown สัญลักษณ์ ** ให้ใช้เครื่องหมาย - นำหน้าแต่ละข้อแทน\\n\\nข้อมูลร้าน (JSON):\\n' + JSON.stringify(payload);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    const textBlocks = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text);
    const text = textBlocks.join('\n').trim();
    if(!text){
      resultBox.innerHTML = '<div class="ai-result" style="color:var(--red);">ไม่ได้รับผลวิเคราะห์ ลองใหม่อีกครั้ง</div>';
    }else{
      resultBox.innerHTML = `<div class="ai-result">${escapeHtml(text).replace(/\n/g,'<br>')}</div>`;
    }
  }catch(e){
    console.error('AI analysis failed', e);
    resultBox.innerHTML = '<div class="ai-result" style="color:var(--red);">วิเคราะห์ไม่สำเร็จ ลองใหม่อีกครั้ง</div>';
  }
  btn.disabled = false;
  btn.textContent = originalText;
}

loadAll();
