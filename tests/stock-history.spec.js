const { test, expect } = require('@playwright/test');
const { boot, nav, snapshot, expectSaved } = require('./helpers');
async function addRestock(page, logExpense = true) {
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('[name="mode"][value="restock"]').check({force:true});
  await page.locator('.restock-variant').selectOption('variant-1');
  await page.locator('.restock-qty').fill('4');
  await page.locator('.restock-row-cost').fill('150');
  await page.locator('.restock-row-price').fill('300');
  await page.locator('[name="restockShippingIn"]').fill('40');
  if (!logExpense) await page.locator('#restockLogExpense').uncheck({force:true});
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 14);
  await page.locator('[data-stock-batch] > summary').click();
  return page.locator('[data-stock-history-edit]');
}

test('direct restock history edits quantity, costs, price, date and shipping atomically and survives reopening saved data', async ({page}) => {
  const errors = await boot(page);
  let form = await addRestock(page);
  await form.locator('[name="qty"]').fill('6');
  await form.locator('[name="cost"]').fill('120');
  await form.locator('[name="price"]').fill('350');
  await form.locator('[name="date"]').fill('2026-10-14');
  await form.locator('[name="shipping"]').fill('60');
  await form.locator('[type="submit"]').click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 16);
  const db = await snapshot(page);
  expect(db.products[0].variants[0]).toMatchObject({qty:16,cost:1720/16,price:350});
  expect(db.transactions.map(tx=>tx.amount).sort((a,b)=>a-b)).toEqual([60,720]);
  expect(db.transactions.every(tx=>tx.date==='2026-10-14')).toBe(true);
  expect(db.products[0].stockHistory[0].edits).toHaveLength(1);
  expect(errors).toEqual([]);
  page = await page.context().newPage();
  await boot(page, db);
  await nav(page,'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('[data-stock-batch] > summary').click();
  form=page.locator('[data-stock-history-edit]');
  await expect(form.locator('[name="qty"]')).toHaveValue('6');
  await form.locator('[data-history-variant]').click();
  await expect(page.locator('#edit-overlay')).toHaveClass(/show/);
  expect(errors).toEqual([]);
});

test('unlogged restocks retain editable history and failed saves can retry without duplicate expenses', async ({page}) => {
  await boot(page);
  const form=await addRestock(page,false);
  await form.locator('[name="qty"]').fill('5');
  await form.locator('[name="shipping"]').fill('50');
  const before=await snapshot(page);
  await page.evaluate(()=>{window.__testSaveError='offline';});
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('บันทึกไม่สำเร็จ');
  expect(await snapshot(page)).toEqual(before);
  await page.locator('#modal-ok-btn').click();
  await expect(form.locator('[name="qty"]')).toHaveValue('5');
  await page.evaluate(()=>{window.__testSaveError=null;});
  await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.products[0].variants[0].qty===15);
  const db=await snapshot(page);
  expect(db.transactions).toHaveLength(1);
  expect(db.transactions[0].amount).toBe(50);
  expect(db.products[0].stockHistory[0].edits).toHaveLength(1);
});

test('history refuses to remove quantities already consumed and rejects stale forms',async({page})=>{
  await boot(page);
  await addRestock(page);
  await page.evaluate(()=>{
    window.__testDB.products[0].variants[0].qty=1;
    window.__testSubscribers.products(structuredClone(window.__testDB.products));
  });
  // Reopen a form against the new balance.
  await nav(page,'home'); await nav(page,'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('[data-stock-batch] > summary').click();
  const form=page.locator('[data-stock-history-edit]');
  await form.locator('[name="qty"]').fill('1');
  const before=await snapshot(page);
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('ถูกขายหรือใช้ไปแล้ว');
  expect(await snapshot(page)).toEqual(before);
  await page.locator('#modal-ok-btn').click();
  await page.evaluate(()=>{
    window.__testDB.products[0].variants[0].qty=2;
    window.__testSubscribers.products(structuredClone(window.__testDB.products));
  });
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('เปลี่ยนแปลง');
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(2);
});

test('new product batch history preserves multiple sizes, supports mobile edits and round trips in backups', async({page})=>{
  await page.setViewportSize({width:390,height:900});
  const errors=await boot(page);
  await nav(page,'stock'); await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('.pb-name').fill('เสื้อประวัติใหม่');
  await page.locator('.pbRowColor').fill('แดง'); await page.locator('.pbRowSize').fill('M'); await page.locator('.pbRowQty').fill('2');
  await page.locator('.pb-price').fill('300'); await page.locator('.pb-cost-perunit').fill('120');
  await page.locator('.add-pb-size-row').click();
  await page.locator('.pbRowColor').last().fill('แดง'); await page.locator('.pbRowSize').last().fill('L'); await page.locator('.pbRowQty').last().fill('3');
  await page.locator('[name="shippingIn"]').fill('25');
  await page.locator('#add-product-submit').click();
  await expectSaved(page,db=>db.products.some(p=>p.name==='เสื้อประวัติใหม่'));
  await page.locator('[data-stock-batch] > summary').click();
  const form=page.locator('[data-stock-history-edit]');
  await expect(form.locator('[data-history-item]')).toHaveCount(2);
  await form.locator('[name="qty"]').first().fill('4');
  await form.locator('[name="cost"]').last().fill('100');
  await form.locator('[type="submit"]').click();
  await expectSaved(page,db=>db.products.find(p=>p.name==='เสื้อประวัติใหม่').variants.find(v=>v.size==='M').qty===4);
  let db=await snapshot(page);
  expect(db.transactions.reduce((sum,tx)=>sum+tx.amount,0)).toBe(805);
  expect(db.products.find(p=>p.name==='เสื้อประวัติใหม่').stockHistory[0].items.map(item=>item.cost)).toEqual([120,100]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.locator('[data-stock-batch] > summary').click();
  await page.screenshot({path:'test-results/stock-history-mobile.png',fullPage:true});
  await page.locator('.data-tools summary').click();
  const downloadEvent=page.waitForEvent('download'); await page.locator('#export-btn').click(); const download=await downloadEvent;
  const backup=JSON.parse(require('node:fs').readFileSync(await download.path(),'utf8'));
  await page.locator('#import-input').setInputFiles({name:'history.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page,saved=>saved.products.find(p=>p.name==='เสื้อประวัติใหม่').stockHistory[0].edits.length===1);
  backup.products.find(p=>p.name==='เสื้อประวัติใหม่').stockHistory[0].items[0].qty=-1;
  await page.locator('#import-input').setInputFiles({name:'bad-history.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await expect(page.locator('#modal-overlay')).toContainText('ไม่ถูกต้อง');
  expect(errors).toEqual([]);
});
