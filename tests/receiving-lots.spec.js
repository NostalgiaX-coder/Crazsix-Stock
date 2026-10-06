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
