const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');
function seed(status = 'ordered') {
  const state = inventory();
  state.preorders = [{id:'po1', customer:'คุณเอ', contact:'', name:'พรีเสื้อ', color:'ดำ', size:'M', type:'new', qty:2, unitPrice:500, unitCost:100, internationalShipping:0, paidAmount:1000, refundedAmount:0, note:'', dueDate:'', createdAt:today(), updatedAt:today(), status}];
  state.pendingOrders = [{id:'stock1', productId:'product-1', name:'เสื้อ Crazsix', color:'ดำ', size:'M', type:'new', qty:4, cost:100, price:250, orderDate:today()}];
  state.transactions = [{id:'paid', type:'income', category:'มัดจำ pre-order', amount:1000, date:today(), preorderId:'po1'}];
  return state;
}
async function pending(page) { await nav(page,'stock'); await page.locator('[data-workspace-tab="pending"]').click(); }
const preorderRow = page => page.locator('[data-pending-preorder="po1"]');
const stockRow = page => page.locator('.variant-row').filter({has:page.locator('[data-pending-id="stock1"]')});
async function selectBoth(page) { await pending(page); await page.locator('#pending-select-all').click(); }
const receive = page => page.locator('#pending-receive-selected').click();
test('ordering checkbox adds and removes the linked preorder in the existing pending workspace', async ({page}) => {
  await boot(page,seed('awaiting'));
  await pending(page); await expect(preorderRow(page)).toHaveCount(0);
  await nav(page,'preorder');
  await expect(page.locator('#receiving-lot-form')).toHaveCount(0);
  await page.locator('[data-preorder-ordered]').check();
  await expectSaved(page,db=>db.preorders[0].status==='ordered');
  await page.locator('[data-workspace="pending"]').click();
  await expect(preorderRow(page)).toBeVisible();
  await expect(preorderRow(page)).toContainText('คุณเอ');
  await nav(page,'preorder'); await page.locator('[data-preorder-ordered]').uncheck();
  await expectSaved(page,db=>db.preorders[0].status==='awaiting');
  await pending(page); await expect(preorderRow(page)).toHaveCount(0);
});
test('mixed pending receipt allocates freight once and keeps customer stock separate until dispatch', async ({page}) => {
  const errors=await boot(page,seed()); await selectBoth(page);
  await page.locator('#pending-bulk-ship').fill('600');
  await expect(preorderRow(page).locator('.pending-share-preview')).toContainText('200');
  await expect(stockRow(page).locator('.pending-share-preview')).toContainText('400');
  await receive(page); await expectSaved(page,db=>db.preorders[0].status==='ready');
  let db=await snapshot(page);
  expect(db.products[0].variants[0].qty).toBe(14);
  expect(db.products[0].variants[0].cost).toBeCloseTo(1800/14);
  expect(db.preorders[0]).toMatchObject({receivedQty:2,internationalShipping:200,internationalShippingRecorded:200});
  expect(db.transactions.filter(t=>t.type==='expense').map(t=>t.amount)).toEqual([600]);
  await expect(preorderRow(page)).toHaveCount(0);
  await nav(page,'preorder'); await expect(page.locator('[data-preorder-ordered]')).toBeChecked();
  await expect(page.locator('[data-preorder-ordered]')).toBeDisabled();
  await page.locator('.preorder-delivery summary').click(); await page.locator('.preorder-fulfill [type="submit"]').click(); await page.locator('#modal-ok-btn').click();
  await expectSaved(page,db=>db.preorders[0].status==='completed');
  db=await snapshot(page); expect(db.transactions.find(t=>t.type==='preorder').profit).toBe(600);
  expect(db.transactions.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0)).toBe(800);
  await nav(page,'shipments'); await expect(page.locator('.shipment-pending-row')).toHaveCount(1);
  expect(errors).toEqual([]);
});
test('weight and manual allocation preserve partial receipts and reject mismatched totals', async ({page}) => {
  await boot(page,seed()); await selectBoth(page);
  await preorderRow(page).locator('.pending-receive-qty').fill('1');
  await stockRow(page).locator('.pending-receive-qty').fill('2');
  await page.locator('#pending-bulk-ship').fill('100'); await page.locator('#pending-allocation-mode').selectOption('weight');
  await preorderRow(page).locator('.pending-weight').fill('1'); await stockRow(page).locator('.pending-weight').fill('3');
  await expect(preorderRow(page).locator('.pending-share-preview')).toContainText('25');
  await receive(page); await expectSaved(page,db=>db.preorders[0].receivedQty===1);
  await nav(page,'preorder'); await expect(page.locator('[data-preorder-ordered]')).toBeDisabled();
  await expect(page.locator('.preorder-delivery')).toHaveCount(0);
  await selectBoth(page); await page.locator('#pending-bulk-ship').fill('100'); await page.locator('#pending-allocation-mode').selectOption('manual');
  await preorderRow(page).locator('.pending-share').fill('40'); await stockRow(page).locator('.pending-share').fill('50');
  await receive(page); await expect(page.locator('#modal-message')).toContainText('ยอดแบ่งค่าส่ง'); await page.locator('#modal-ok-btn').click();
  await stockRow(page).locator('.pending-share').fill('60'); await receive(page);
  await expectSaved(page,db=>db.preorders[0].status==='ready');
  expect((await snapshot(page)).preorders[0].internationalShipping).toBe(65);
});
test('failed receipt and checkbox writes preserve data and retry only once', async ({page}) => {
  const state=seed('awaiting'); await boot(page,state); await nav(page,'preorder');
  await page.evaluate(()=>window.__testSaveError='offline'); await page.locator('[data-preorder-ordered]').click();
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ'); await expect(page.locator('[data-preorder-ordered]')).not.toBeChecked();
  await page.locator('#modal-ok-btn').click(); await page.evaluate(()=>window.__testSaveError=null); await page.locator('[data-preorder-ordered]').check();
  await expectSaved(page,db=>db.preorders[0].status==='ordered'); await selectBoth(page);
  await page.locator('#pending-bulk-ship').fill('100'); await page.evaluate(()=>window.__testSaveError='offline'); await receive(page);
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ'); expect((await snapshot(page)).products).toEqual(state.products);
  await page.locator('#modal-ok-btn').click(); await page.evaluate(()=>window.__testSaveError=null); await receive(page);
  await expectSaved(page,db=>db.transactions.filter(t=>t.receivingLot).length===1);
});
test('stale pending receipt cannot overwrite another device', async ({page}) => {
  await boot(page,seed()); await selectBoth(page); await page.locator('#pending-bulk-ship').fill('100');
  await page.evaluate(()=>{window.__testDB.pendingOrders[0].qty=3;});
  await receive(page); await expect(page.locator('#modal-message')).toContainText('อุปกรณ์อื่น');
  expect((await snapshot(page)).preorders[0].status).toBe('ordered'); expect((await snapshot(page)).transactions.filter(t=>t.receivingLot)).toHaveLength(0);
});
test('received preorder backups round trip and reject altered freight allocation', async ({page}) => {
  await boot(page,seed()); await selectBoth(page); await page.locator('#pending-bulk-ship').fill('99.99'); await receive(page);
  await expectSaved(page,db=>db.preorders[0].status==='ready'); await page.locator('.data-tools summary').click();
  const event=page.waitForEvent('download'); await page.locator('#export-btn').click(); const download=await event;
  const backup=JSON.parse(require('node:fs').readFileSync(await download.path(),'utf8'));
  const upload=data=>page.locator('#import-input').setInputFiles({name:'receipt.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
  await upload(backup); await page.locator('#modal-ok-btn').click(); await expectSaved(page,db=>db.preorders[0].internationalShippingRecorded===33.33);
  backup.transactions.find(t=>t.receivingLot).receivingLot.items[0].share=0;
  await upload(backup); await expect(page.locator('#modal-message')).toContainText('ไม่ถูกต้อง');
});
test('mobile pending workspace contains both types without horizontal overflow', async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await boot(page,seed()); await selectBoth(page);
  await page.locator('#pending-bulk-ship').fill('600'); await expect(preorderRow(page)).toBeVisible();
  await page.screenshot({path:'test-results/pending-preorders-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});


test('correct a fully received purchase and preserve freight with atomic retry', async ({page}) => {
  const state = seed();
  state.transactions.push({id:'purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',amount:400,date:today(),pendingIds:['stock1']});
  const errors = await boot(page,state); await pending(page);
  await stockRow(page).locator('.pending-select').check();
  await page.locator('#pending-bulk-ship').fill('80'); await receive(page);
  await expectSaved(page,db=>db.pendingOrders.length===0);
  await page.locator('[data-workspace-tab="history"]').click();
  await page.locator('#workspace-history .receipt-lot > summary').first().click();
  const form = page.locator('[data-receipt-edit]');
  await form.locator('[name="qty"]').fill('2');
  await page.evaluate(()=>window.__testSaveError='offline');
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(14);
  await page.locator('#modal-ok-btn').click();
  await page.evaluate(()=>window.__testSaveError=null);
  await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.products[0].variants[0].qty===12);
  const db = await snapshot(page);
  expect(db.products[0].variants[0].cost).toBeCloseTo(1280/12);
  expect(db.transactions.find(tx=>tx.id==='purchase').amount).toBe(400);
  expect(db.pendingOrders[0]).toMatchObject({id:'stock1',qty:2,cost:100,price:250,receivedQty:2,originalQty:4});
  expect(db.transactions.find(tx=>tx.receivingLot).amount).toBe(80);
  expect(db.transactions.find(tx=>tx.receivingLot).receivingLot.items[0].qty).toBe(2);
  expect(db.products[0].variants[0].adjustments).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('zero freight receipts retain editable history and reject reducing stock below zero', async ({page}) => {
  const state = seed(); state.products[0].variants[0].qty=0;
  state.transactions.push({id:'purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',amount:400,date:today(),pendingIds:['stock1']});
  await boot(page,state); await pending(page); await stockRow(page).locator('.pending-select').check(); await receive(page);
  await expectSaved(page,db=>db.transactions.some(tx=>tx.receivingLot));
  await page.evaluate(()=>{ const db=window.__testDB; db.products[0].variants[0].qty=1; window.__testSubscribers.products(structuredClone(db.products)); });
  await page.locator('[data-workspace-tab="history"]').click();
  await page.locator('#workspace-history .receipt-lot > summary').first().click();
  await page.locator('[data-receipt-edit] [name="qty"]').fill('1');
  await page.locator('[data-receipt-edit] [type="submit"]').click();
  await expect(page.locator('#modal-message')).toContainText('ไม่พอ');
  expect((await snapshot(page)).transactions.find(tx=>tx.id==='purchase').amount).toBe(400);
});


test('attach paid pending purchases to an existing lot with their remembered costs and no duplicate expense', async ({page}) => {
  const state=seed();
  state.pendingOrders.push({...state.pendingOrders[0],id:'extra',qty:2,cost:120,note:'ต้นทุนเดิม'}, {id:'new-shirt',name:'เสื้อใหม่',color:'น้ำเงิน',size:'XL',type:'new',qty:3,cost:80,price:200,orderDate:today(),chestInches:24,lengthInches:28,note:'ขนาดจริง'});
  state.transactions.push({id:'purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',amount:880,date:today(),pendingIds:['stock1','extra','new-shirt']});
  const errors=await boot(page,state); await pending(page);
  await page.locator('.pending-select[data-pending-id="stock1"]').check();
  await page.locator('.pending-receive-qty[data-pending-id="stock1"]').fill('4');
  await preorderRow(page).locator('.pending-select').check();
  await page.locator('#pending-bulk-ship').fill('60'); await receive(page);
  await expectSaved(page,db=>db.preorders[0].status==='ready'); await openHistory(page);
  const form=page.locator('[data-receipt-edit]');
  await form.locator('[name="qty"]').nth(0).fill('3'); await form.locator('[name="total"]').fill('100');
  await form.locator('[data-receipt-add]').click();
  let row=form.locator('.receipt-add-row').nth(0);
  await row.locator('[name="pendingKey"]').selectOption({label:'เข้าสต็อก · เสื้อ Crazsix · ดำ M · รอรับ 2 ชิ้น · ต้นทุน ฿120/ชิ้น'});
  await expect(row.locator('[name="addQty"]')).toHaveValue('2');
  await form.locator('[data-receipt-add]').click(); row=form.locator('.receipt-add-row').nth(1);
  await row.locator('[name="pendingKey"]').selectOption({label:'เข้าสต็อก · เสื้อใหม่ · น้ำเงิน XL · รอรับ 3 ชิ้น · ต้นทุน ฿80/ชิ้น'});
  await page.evaluate(()=>window.__testSaveError='offline'); await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ'); expect((await snapshot(page)).products).toHaveLength(1);
  await page.locator('#modal-ok-btn').click(); await page.evaluate(()=>window.__testSaveError=null); await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.products.length===2);
  const db=await snapshot(page), tx=db.transactions.find(t=>t.receivingLot);
  expect(tx.amount).toBe(100); expect(tx.receivingLot.items.map(i=>i.share)).toEqual([30,20,20,30]);
  expect(db.products.find(p=>p.id==='product-1').variants[0].qty).toBe(15);
  expect(db.products.find(p=>p.id==='product-1').variants[0].cost).toBeCloseTo(1590/15);
  expect(db.products.find(p=>p.name==='เสื้อใหม่').variants[0]).toMatchObject({qty:3,cost:90,price:200,chestInches:24,lengthInches:28});
  expect(tx.receivingLot.items.find(i=>i.id==='extra').purchase).toMatchObject({cost:120,note:'ต้นทุนเดิม'});
  expect(db.pendingOrders).toHaveLength(1); expect(db.pendingOrders[0]).toMatchObject({id:'stock1',qty:1,cost:100});
  expect(db.transactions.find(t=>t.id==='purchase').amount).toBe(880);
  expect(db.transactions.filter(t=>t.category==='สั่งซื้อสินค้า (รอของมาส่ง)')).toHaveLength(1);
  expect(db.preorders[0].internationalShippingRecorded).toBe(20); expect(errors).toEqual([]);
});

test('freight correction cannot change a delivered preorder or partially edit its stock', async ({page}) => {
  await boot(page,seed()); await selectBoth(page); await page.locator('#pending-bulk-ship').fill('60'); await receive(page);
  await expectSaved(page,db=>db.preorders[0].status==='ready');
  await nav(page,'preorder'); await page.locator('.preorder-delivery summary').click();
  await page.locator('.preorder-fulfill [type="submit"]').click(); await page.locator('#modal-ok-btn').click();
  await expectSaved(page,db=>db.preorders[0].status==='completed');
  const before=await snapshot(page); await pending(page);
  await page.locator('[data-workspace-tab="history"]').click();
  await page.locator('#workspace-history .receipt-lot > summary').first().click();
  await page.locator('[data-receipt-edit] [name="total"]').fill('120');
  await page.locator('[data-receipt-edit] [type="submit"]').click();
  await expect(page.locator('#modal-message')).toContainText('ส่งมอบหรือยกเลิกแล้ว');
  expect(await snapshot(page)).toEqual(before);
});

function legacyF1() {
  const state=inventory(); state.products[0].name='F1 Jacket';
  state.products[0].variants=[{id:'f1-xl',color:'Black',size:'XL',type:'new',qty:4,cost:120,price:250}];
  state.transactions=[{id:'purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',amount:400,date:today(),pendingIds:['xl-top','xl-bottom']},
    {id:'old-lot',type:'expense',category:'ค่าส่งสินค้าเข้า',amount:80,date:today(),desc:'ล็อตรับของ F1',receivingLot:{name:'F1',mode:'manual',items:[
      {kind:'stock',id:'xl-top',label:'เข้าสต็อก · F1 Jacket · Black XL',qty:2,share:40,weight:0},
      {kind:'stock',id:'xl-bottom',label:'เข้าสต็อก · F1 Jacket · Black XL',qty:2,share:40,weight:0}
    ]}}];
  return state;
}
async function openHistory(page) {
  await nav(page,'stock'); await page.locator('[data-workspace-tab="history"]').click();
  await page.locator('#workspace-history .receipt-lot > summary').first().click();
}
test('legacy F1 XL quantities are editable and the upper saved row can be removed',async ({page})=>{
  const errors=await boot(page,legacyF1()); await openHistory(page);
  let form=page.locator('[data-receipt-edit]');
  const rows=form.locator('.receipt-existing-row');
  await expect(rows.first().locator('[name="qty"]')).toBeEditable();
  await rows.locator('[name="legacyCost"]').nth(0).fill('100');
  await rows.locator('[name="legacyCost"]').nth(1).fill('100');
  await rows.first().locator('[name="qty"]').fill('1');
  await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.products[0].variants[0].qty===3);
  let db=await snapshot(page);
  expect(db.products[0].variants[0].cost).toBeCloseTo(380/3);
  expect(db.transactions.find(t=>t.id==='purchase').amount).toBe(400);
  expect(db.pendingOrders[0]).toMatchObject({id:'xl-top',qty:1,cost:100});
  await page.locator('#workspace-history .receipt-lot > summary').first().click();
  form=page.locator('[data-receipt-edit]');
  await form.locator('[data-receipt-remove]').first().click();
  await expectSaved(page,db=>db.transactions.find(t=>t.id==='old-lot').receivingLot.items.length===1);
  db=await snapshot(page);
  expect(db.transactions.find(t=>t.id==='old-lot').receivingLot.items[0].id).toBe('xl-bottom');
  expect(db.transactions.find(t=>t.id==='old-lot').receivingLot.items[0].share).toBe(80);
  expect(db.products[0].variants[0]).toMatchObject({qty:2,cost:140});
  expect(db.transactions.find(t=>t.id==='purchase').amount).toBe(400);
  expect(db.pendingOrders[0]).toMatchObject({id:'xl-top',qty:2,cost:100,receivedQty:0});
  expect(errors).toEqual([]);
});

test('legacy return requires a cost and leaves data untouched when it is missing',async ({page})=>{
  const state=legacyF1(); await boot(page,state); await openHistory(page);
  const form=page.locator('[data-receipt-edit]'), row=form.locator('.receipt-existing-row').first();
  await row.locator('[data-receipt-remove]').click();
  await expect(page.locator('#modal-message')).toContainText('ต้นทุนเดิม');
  expect(await snapshot(page)).toMatchObject(state);
  await page.locator('#modal-ok-btn').click();
  await expect(row.locator('[name="qty"]')).toHaveValue('2');
});

test('remove every shirt from an old lot and keep a reversible history that passes backup validation',async ({page})=>{
  await boot(page,legacyF1()); await openHistory(page);
  const form=page.locator('[data-receipt-edit]');
  for (let i=0;i<2;i++) {
    const row=form.locator('.receipt-existing-row').first();
    await row.locator('[name="legacyCost"]').fill('100');
    await row.locator('[data-receipt-remove]').click();
    await expectSaved(page,db=>db.transactions.find(tx=>tx.id==='old-lot').receivingLot.items.length===1-i);
    if (i===0) await page.locator('#workspace-history .receipt-lot > summary').first().click();
  }
  await expectSaved(page,db=>db.products[0].variants[0].qty===0);
  const db=await snapshot(page), tx=db.transactions.find(t=>t.id==='old-lot');
  expect(tx.receivingLot).toMatchObject({items:[],cancelled:true});
  expect(tx.receivingLot.corrections[0].previousItems).toHaveLength(2);
  expect(db.transactions.find(t=>t.id==='purchase').amount).toBe(400);
  expect(db.pendingOrders).toHaveLength(2);
  expect(db.pendingOrders.every(order=>order.qty===2 && order.cost===100)).toBe(true);
  await page.locator('.data-tools summary').click();
  const event=page.waitForEvent('download'); await page.locator('#export-btn').click(); const download=await event;
  const backup=JSON.parse(require('node:fs').readFileSync(await download.path(),'utf8'));
  await page.locator('#import-input').setInputFiles({name:'removed-lot.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await expect(page.locator('#modal-message')).not.toContainText('ไม่ถูกต้อง');
});

test('new lots return their exact purchase data and reattach it without entering cost or buying twice', async ({page})=>{
  const state=seed(); state.preorders=[];
  Object.assign(state.pendingOrders[0],{chestInches:24,lengthInches:28,note:'ล็อตแรก',orderDate:'2026-10-01'});
  state.transactions=[{id:'purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',amount:400,date:today(),pendingIds:['stock1']}];
  const errors=await boot(page,state); await pending(page); await page.locator('#pending-select-all').click(); await page.locator('#pending-bulk-ship').fill('80'); await receive(page);
  await expectSaved(page,db=>db.pendingOrders.length===0);
  let db=await snapshot(page), lot=db.transactions.find(tx=>tx.receivingLot);
  expect(lot.receivingLot.items[0].purchase).toMatchObject(state.pendingOrders[0]);
  await openHistory(page); let form=page.locator('[data-receipt-edit]');
  await expect(form.locator('[name="legacyCost"]')).toHaveCount(0);
  await form.locator('[data-receipt-remove]').click();
  await expectSaved(page,db=>db.pendingOrders.length===1);
  db=await snapshot(page);
  expect(db.pendingOrders[0]).toMatchObject({...state.pendingOrders[0],receivedQty:0,originalQty:4});
  expect(db.transactions.find(tx=>tx.id==='purchase')).toEqual(state.transactions[0]);
  await page.locator('[data-workspace-tab="pending"]').click();
  await expect(page.locator('.pending-select[data-pending-id="stock1"]')).toBeVisible();
  await expect(page.locator('.pending-receive-qty')).toHaveValue('4');
  await page.locator('[data-workspace-tab="history"]').click();
  await page.locator('#workspace-history .receipt-lot > summary').first().click(); form=page.locator('[data-receipt-edit]');
  await form.locator('[data-receipt-add]').click(); await form.locator('[name="pendingKey"]').selectOption('0');
  await expect(form.locator('[name="legacyCost"]')).toHaveCount(0);
  await form.locator('[name="total"]').fill('80'); await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.pendingOrders.length===0);
  db=await snapshot(page);
  expect(db.transactions.find(tx=>tx.id==='purchase')).toEqual(state.transactions[0]);
  expect(db.products[0].variants.find(v=>v.chestInches===24)).toMatchObject({qty:4,cost:120});
  expect(db.transactions.find(tx=>tx.receivingLot).receivingLot.items[0].purchase.cost).toBe(100);
  expect(errors).toEqual([]);
});

test('attach partially, consume the remainder by editing quantity, then return the full order',async ({page})=>{
  const state=seed(); state.preorders=[];
  state.pendingOrders.push({...state.pendingOrders[0],id:'second-order',color:'แดง',qty:5,cost:80,note:'รับบางส่วน'});
  const errors=await boot(page,state); await pending(page); await stockRow(page).locator('.pending-select').check(); await receive(page);
  await expectSaved(page,db=>db.pendingOrders.length===1); await openHistory(page);
  let form=page.locator('[data-receipt-edit]');
  await form.locator('[data-receipt-add]').click(); await form.locator('[name="pendingKey"]').selectOption('0');
  await form.locator('[name="addQty"]').fill('2'); await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.pendingOrders[0].qty===3);
  await page.locator('#workspace-history .receipt-lot > summary').first().click(); form=page.locator('[data-receipt-edit]');
  await form.locator('[name="qty"]').nth(1).fill('5'); await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.pendingOrders.length===0);
  await page.locator('#workspace-history .receipt-lot > summary').first().click(); form=page.locator('[data-receipt-edit]');
  await form.locator('[data-receipt-remove]').nth(1).click();
  await expectSaved(page,db=>db.pendingOrders.length===1);
  expect((await snapshot(page)).pendingOrders[0]).toMatchObject({id:'second-order',qty:5,receivedQty:0,originalQty:5,cost:80,note:'รับบางส่วน'});
  expect(errors).toEqual([]);
});

test('attaching the same pending order twice is rejected without moving stock or changing cash',async ({page})=>{
  const state=seed(); state.preorders=[]; state.pendingOrders.push({...state.pendingOrders[0],id:'second-order',color:'แดง',qty:2});
  await boot(page,state); await pending(page); await stockRow(page).locator('.pending-select').check(); await receive(page);
  await expectSaved(page,db=>db.pendingOrders.length===1); const before=await snapshot(page); await openHistory(page);
  const form=page.locator('[data-receipt-edit]');
  for(let i=0;i<2;i++) { await form.locator('[data-receipt-add]').click(); await form.locator('[name="pendingKey"]').nth(i).selectOption('0'); }
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-message')).toContainText('อยู่ในล็อตแล้ว'); expect(await snapshot(page)).toEqual(before);
});

for (const width of [390,1440]) {
  test(`return saves immediately and XL disappears from ready stock while L remains at ${width}px`,async ({page})=>{
    await page.setViewportSize({width,height:900});
    const state=inventory(); state.products[0].name='F1 Jacket';
    state.products[0].variants=[{id:'xl',color:'Black',size:'XL',type:'new',qty:0,cost:100,price:250},{id:'l',color:'Black',size:'L',type:'new',qty:6,cost:100,price:250}];
    state.pendingOrders=[{id:'order-xl',productId:'product-1',name:'F1 Jacket',color:'Black',size:'XL',type:'new',qty:2,cost:100,price:250,orderDate:today()}];
    const errors=await boot(page,state); await pending(page); await page.locator('#pending-select-all').click(); await page.locator('#pending-bulk-ship').fill('40'); await receive(page);
    await expectSaved(page,db=>db.products[0].variants[0].qty===2); await openHistory(page);
    await expect(page.locator('.receipt-advanced')).not.toHaveAttribute('open');
    await page.screenshot({path:`test-results/simple-receiving-${width}.png`,fullPage:true});
    await page.getByRole('button',{name:'คืนของ',exact:true}).click();
    await expectSaved(page,db=>db.pendingOrders.some(o=>o.id==='order-xl' && o.qty===2));
    await page.locator('[data-workspace-tab="inventory"]').click();
    await expect(page.locator('[data-stock-section="available"] [data-stock-variant="xl"]')).toHaveCount(0);
    await expect(page.locator('[data-stock-section="available"] [data-stock-variant="l"]')).toBeVisible();
    await expect(page.locator('[data-stock-section="soldout"] [data-stock-variant="xl"]')).toBeVisible();
    await page.locator('[data-workspace-tab="pending"]').click();
    await expect(page.locator('.pending-receive-qty')).toHaveValue('2');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('immediate return fails safely and retry returns the order exactly once',async ({page})=>{
  const state=seed(); state.preorders=[];
  await boot(page,state); await pending(page); await stockRow(page).locator('.pending-select').check(); await receive(page);
  await expectSaved(page,db=>db.pendingOrders.length===0); const before=await snapshot(page); await openHistory(page);
  await page.evaluate(()=>window.__testSaveError='offline'); await page.getByRole('button',{name:'คืนของ',exact:true}).click();
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ'); expect(await snapshot(page)).toEqual(before);
  await page.locator('#modal-ok-btn').click(); await page.evaluate(()=>window.__testSaveError=null);
  await page.getByRole('button',{name:'คืนของ',exact:true}).click();
  await expectSaved(page,db=>db.pendingOrders.length===1);
  expect((await snapshot(page)).pendingOrders[0]).toMatchObject({id:'stock1',qty:4,cost:100});
  await expect(page.getByRole('status').filter({hasText:'คืน 4 ชิ้นแล้ว'}).first()).toBeVisible();
  await page.getByRole('button',{name:'ดูของรอรับ',exact:true}).click();
  await expect(page.locator('#workspace-pending')).toBeVisible();
  await expect(page.locator('.pending-receive-qty')).toHaveValue('4');
});

test('legacy lots recover exact costs from purchase totals and remaining orders without manual entry',async ({page})=>{
  const state=inventory(); state.products[0].name='F1 Jacket';
  state.products[0].variants=[{id:'xl',color:'Black',size:'XL',type:'new',qty:4,cost:400,price:990}, {id:'l-plain',color:'Black',size:'L',type:'new',qty:0,cost:500,price:990}, {id:'l-measured',color:'Black',size:'L',type:'new',qty:4,cost:350,price:990,chestInches:46,lengthInches:26}];
  state.pendingOrders=[{id:'second-xl',productId:'product-1',name:'F1 Jacket',color:'Black',size:'XL',type:'new',qty:1,cost:325.5777777777778,price:990,orderDate:'2026-10-04',originalQty:3,receivedQty:2}];
  state.transactions=[
    {id:'xl-purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',amount:635.82,date:'2026-10-01',pendingIds:['first-xl'],desc:'F1 Jacket · Black · ไซส์ XL · มือ1 x2'},
    {id:'l-purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',amount:1287.51,date:'2026-10-01',pendingIds:['measured-l'],desc:'F1 Jacket · Black · ไซส์ L · มือ1 · อก 46 นิ้ว · ยาว 26 นิ้ว x4'},
    {id:'old-lot',type:'expense',category:'ค่าส่งสินค้าเข้า',date:today(),amount:225.3,receivingLot:{name:'F1',mode:'manual',items:[
      {id:'first-xl',kind:'stock',qty:2,share:64.37,label:'เข้าสต็อก · F1 Jacket · Black XL',weight:0},
      {id:'second-xl',kind:'stock',qty:2,share:64.37,label:'เข้าสต็อก · F1 Jacket · Black XL',weight:0},
      {id:'measured-l',kind:'stock',qty:3,share:96.56,label:'เข้าสต็อก · F1 Jacket · Black L',weight:0}
    ]}}];
  const errors=await boot(page,state); await openHistory(page);
  const form=page.locator('[data-receipt-edit]');
  await expect(form.locator('[name="legacyCost"]')).toHaveCount(0);
  await expect(form.locator('.receipt-existing-row').nth(0)).toContainText('ต้นทุน ฿317.91/ชิ้น');
  await expect(form.locator('.receipt-existing-row').nth(1)).toContainText('ต้นทุน ฿325.58/ชิ้น');
  await expect(form.locator('.receipt-existing-row').nth(2)).toContainText('ต้นทุน ฿321.88/ชิ้น');
  await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.transactions.find(t=>t.id==='old-lot').receivingLot.items.every(i=>i.purchase));
  let db=await snapshot(page), items=db.transactions.find(t=>t.id==='old-lot').receivingLot.items;
  expect(items.map(i=>i.purchase.cost)).toEqual([317.91,325.5777777777778,321.8775]);
  expect(items[2]).toMatchObject({variantId:'l-measured',purchase:{cost:321.8775,chestInches:46,lengthInches:26}});
  expect(db.products).toEqual(state.products);
  await page.addInitScript(saved => { window.__testDB = saved; }, await snapshot(page));
  await page.reload(); await openHistory(page);
  await page.locator('[data-receipt-remove]').nth(2).click();
  await expectSaved(page,db=>db.pendingOrders.some(o=>o.id==='measured-l'));
  db=await snapshot(page);
  expect(db.pendingOrders.find(o=>o.id==='measured-l')).toMatchObject({qty:3,cost:321.8775,chestInches:46,lengthInches:26,orderDate:'2026-10-01'});
  expect(db.transactions.find(t=>t.id==='l-purchase')).toEqual(state.transactions[1]);
  expect(errors).toEqual([]);
});

test('entering an unknown legacy cost and saving without changing quantity remembers it after reload',async ({page})=>{
  const state=legacyF1(); const errors=await boot(page,state); await openHistory(page);
  const form=page.locator('[data-receipt-edit]');
  await form.locator('[name="legacyCost"]').nth(0).fill('101.25');
  await form.locator('[name="legacyCost"]').nth(1).fill('98.75');
  await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.transactions.find(t=>t.id==='old-lot').receivingLot.items[0].purchase?.cost===101.25);
  expect((await snapshot(page)).products).toEqual(state.products);
  await page.addInitScript(saved => { window.__testDB = saved; }, await snapshot(page));
  await page.reload(); await openHistory(page);
  await expect(page.locator('[name="legacyCost"]')).toHaveCount(0);
  await expect(page.locator('.receipt-existing-row').first()).toContainText('ต้นทุน ฿101.25/ชิ้น');
  await page.locator('[data-receipt-remove]').first().click();
  await expectSaved(page,db=>db.pendingOrders[0]?.id==='xl-top');
  expect((await snapshot(page)).pendingOrders[0].cost).toBe(101.25);
  expect(errors).toEqual([]);
});
