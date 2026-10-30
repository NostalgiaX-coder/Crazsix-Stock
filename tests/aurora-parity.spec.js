const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, today, snapshot, expectSaved } = require('./helpers');

test('direct purchase menu records a paid multi-item purchase once, then receives the selected batch', async ({ page }) => {
  const errors=await boot(page,{products:[],transactions:[],pendingOrders:[]});
  await nav(page,'purchase');
  await expect(page.locator('#pending-fields')).toBeVisible();
  await expect(page.locator('[name=mode][value=pending]')).toBeChecked();
  for (let i=0;i<2;i++) {
    if(i)await page.locator('#add-pending-row').click();
    const row=page.locator('.pending-row').nth(i);
    await row.locator('.pRowName').fill(i?'กางเกง':'เสื้อ');
    await row.locator('.pRowColor').fill('ดำ');await row.locator('.pRowSize').fill(i?'L':'M');
    await row.locator('.pRowQty').fill(i?'3':'2');await row.locator('.pRowCost').fill('100');await row.locator('.pRowPrice').fill('250');
  }
  await page.locator('#add-product-submit').click();
  await expectSaved(page,s=>s.pendingOrders.length===2);
  let db=await snapshot(page);expect(db.products).toEqual([]);expect(db.transactions).toHaveLength(1);expect(db.transactions[0].amount).toBe(500);
  await nav(page,'receiving');await expect(page.locator('#workspace-pending')).toBeVisible();
  await page.locator('#pending-select-all').click();await page.locator('#pending-bulk-ship').fill('50');await page.locator('#pending-receive-selected').click();
  await expectSaved(page,s=>s.pendingOrders.length===0&&s.products.length===2);
  db=await snapshot(page);expect(db.transactions.reduce((n,t)=>n+t.amount,0)).toBe(550);expect(db.products.flatMap(p=>p.variants).reduce((n,v)=>n+v.qty,0)).toBe(5);
  await page.locator('[data-workspace-tab=history]').click();await expect(page.locator('[data-receipt-edit]')).toHaveCount(1);expect(errors).toEqual([]);
});

async function addCart(page,{color='ดำ',qty='1',partial=false,deposit='0',shipping='0'}={}) {
  const card=page.locator('[data-sale-card]').first();await card.locator('.sell-color-select').selectOption(color);
  await card.locator('.sell-qty').fill(qty);await card.locator('.sell-personal-percent').fill('10');
  await card.locator('.sell-shipping').fill(shipping);await card.locator('.sell-customer').fill('ลูกค้าเดียวกัน');
  await card.locator('.sell-installment').setChecked(partial);if(partial)await card.locator('.sell-deposit').fill(deposit);
  await card.locator('.sell-add-cart').click();
}

test('cart sells multiple options with full/partial payments atomically and preserves shipping and allocation',async({page})=>{
  const errors=await boot(page);await nav(page,'sell');await addCart(page,{qty:'2',shipping:'30'});await addCart(page,{color:'ขาว',partial:true,deposit:'50'});
  expect((await snapshot(page)).transactions).toHaveLength(0);await expect(page.locator('[data-cart-key]')).toHaveCount(2);
  await expect(page.locator('#sale-cart-summary')).toContainText('ยอดขาย ฿700');await expect(page.locator('#sale-cart-summary')).toContainText('รับจริง ฿550');
  await page.locator('#sale-cart-checkout').click();await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.transactions.filter(t=>t.category==='ขายสินค้า').length===2);
  const db=await snapshot(page);expect(db.products[0].variants.map(v=>v.qty)).toEqual([8,0]);expect(db.transactions.filter(t=>t.type==='income').reduce((n,t)=>n+t.amount,0)).toBe(550);
  expect(db.transactions.find(t=>t.type==='installment')).toMatchObject({amount:200,paidAmount:50,personalUsePercent:10});
  expect(db.transactions.find(t=>t.category==='ค่าส่ง')).toMatchObject({amount:30});expect(await page.evaluate(()=>window.__testWrites.length)).toBe(1);
  await nav(page,'shipments');await expect(page.locator('.shipment-select')).toHaveCount(2);
  await nav(page,'allocation');await expect(page.locator('#tab-content')).toContainText('฿70');expect(errors).toEqual([]);
});

test('invalid later cart row leaves every item unsold and failed writes retain cart for retry',async({page})=>{
  await boot(page);await nav(page,'sell');await addCart(page,{qty:'2'});await addCart(page,{color:'ขาว'});
  await page.locator('[data-cart-field=qty]').nth(1).fill('2');await page.locator('#sale-cart-checkout').click();await expect(page.locator('#modal-message')).toContainText('คงเหลือไม่พอ');
  expect((await snapshot(page)).transactions).toHaveLength(0);expect((await snapshot(page)).products[0].variants[0].qty).toBe(10);
  await page.locator('#modal-ok-btn').click();await page.locator('[data-cart-field=qty]').nth(1).fill('1');await page.evaluate(()=>window.__testSaveError='offline');
  await page.locator('#sale-cart-checkout').click();await page.locator('#modal-ok-btn').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');await page.locator('#modal-ok-btn').click();
  await expect(page.locator('[data-cart-key]')).toHaveCount(2);expect((await snapshot(page)).transactions).toHaveLength(0);await page.evaluate(()=>delete window.__testSaveError);
  await page.locator('#sale-cart-checkout').click();await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.products[0].variants[0].qty===8);expect(await page.evaluate(()=>window.__testWrites.length)).toBe(1);
});

test('duplicate variant lines are checked against their combined quantity',async({page})=>{
  await boot(page);await nav(page,'sell');await addCart(page,{qty:'6'});await addCart(page,{qty:'5'});
  await expect(page.locator('#modal-message')).toContainText('คงเหลือไม่พอ');await page.locator('#modal-ok-btn').click();await expect(page.locator('[data-cart-key]')).toHaveCount(1);expect((await snapshot(page)).products[0].variants[0].qty).toBe(10);
});

function debts(){const s=inventory();s.transactions=[1,2].map(i=>({id:'sale-'+i,type:'installment',category:'ขายสินค้า',desc:'ลูกค้า '+i,amount:250,paidAmount:50,date:today(),dueDate:today(),productId:'variant-1',qty:1,profit:150}));return s;}
test('multi-payment validates and commits once, with no duplicate sale or inventory movement',async({page})=>{
  const seed=debts();const errors=await boot(page,seed);await nav(page,'installment');await page.locator('.batch-payment summary').click();await page.locator('#batch-payment-all').check();
  await page.locator('[name="amount-sale-1"]').fill('100');await page.locator('#batch-payment-submit').click();await page.locator('#modal-ok-btn').click();
  await expectSaved(page,s=>s.transactions.find(t=>t.id==='sale-1').paidAmount===150&&s.transactions.find(t=>t.id==='sale-2').paidAmount===250);
  const db=await snapshot(page);expect(db.products).toEqual(seed.products);expect(db.transactions.filter(t=>t.type==='income').reduce((n,t)=>n+t.amount,0)).toBe(300);expect(await page.evaluate(()=>window.__testWrites.length)).toBe(1);expect(errors).toEqual([]);
});
test('multi-payment failure rolls back all debt balances and can retry from the same form',async({page})=>{
  const seed=debts();await boot(page,seed);await nav(page,'installment');await page.locator('.batch-payment summary').click();await page.locator('#batch-payment-all').check();await page.evaluate(()=>window.__testSaveError='offline');
  await page.locator('#batch-payment-submit').click();await page.locator('#modal-ok-btn').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');expect((await snapshot(page)).transactions).toEqual(seed.transactions);
  await page.locator('#modal-ok-btn').click();await page.evaluate(()=>delete window.__testSaveError);await page.locator('#batch-payment-submit').click();await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.transactions.filter(t=>t.type==='income').length===2);
});

test('every original menu and stock workspace remains available on mobile alongside direct purchasing',async({page})=>{
  await page.setViewportSize({width:390,height:844});const errors=await boot(page);
  for(const tab of ['home','tasks','stock','ads','preorder','sell','shipments','installment','tx','profit','report','ai','purchase','receiving','allocation']) {
    await page.locator('#workspace-jump').selectOption(tab);await expect(page.locator('#tab-content')).not.toBeEmpty();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  }
  await page.locator('#workspace-jump').selectOption('stock');for(const workspace of ['inventory','add','pending','history','shipping','count']){await page.locator(`[data-workspace-tab=${workspace}]`).click();await expect(page.locator('#workspace-'+workspace)).toBeVisible();}
  expect(errors).toEqual([]);
});
