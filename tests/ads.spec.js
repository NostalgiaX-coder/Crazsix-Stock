const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');
const campaign = overrides => ({ id:'ad-1', name:'แอดเสื้อรอบแรก', productId:'product-1', channel:'Facebook / Instagram', status:'active', startDate:today(), endDate:today(), budget:300, targetQty:10, reservePercent:20, note:'กลุ่มลูกค้าร้าน', url:'https://example.com/ad', ...overrides });
const sale = overrides => ({id:'sale-1', type:'income', category:'ขายสินค้า', date:today(), desc:'ขายเสื้อ', amount:1000, qty:4, profit:600, productId:'variant-1', stockProductId:'product-1', ...overrides});
const spend = overrides => ({id:'spend-1', type:'expense', category:'ค่าโฆษณาสินค้า', date:today(), desc:'ค่าแอด', amount:200, adCampaignId:'ad-1', ...overrides});
function seeded({ sales=true, spending=true, overrides={} }={}) {const s=inventory();s.adCampaigns=[campaign(overrides)];s.transactions=[...(sales?[sale({adCampaignId:'ad-1'})]:[]),...(spending?[spend()]:[])];return s;}
async function create(page) {
 await nav(page,'ads');
 const form=page.locator('#ad-create-form');
 await form.locator('[name="name"]').fill('แอดเสื้อใหม่');
 await form.locator('[name="productId"]').selectOption('product-1');
 await form.locator('[name="budget"]').fill('300');
 await form.locator('[name="targetQty"]').fill('10');
 await form.locator('[type="submit"]').click();
 await expectSaved(page,db=>db.adCampaigns?.length===1);
}
async function openSpend(page) { await page.locator('.ad-spend-details > summary').click();return page.locator('.ad-spend-form'); }
async function exportText(page,selector) {const waiting=page.waitForEvent('download');await page.locator(selector).click();const d=await waiting;const chunks=[];for await (const chunk of await d.createReadStream())chunks.push(chunk);return Buffer.concat(chunks).toString();}

test('campaign budgets plan unit costs; only actual spending affects cash and product profit', async ({page})=>{
 const errors=await boot(page);await create(page);
 let db=await snapshot(page);expect(db.transactions).toHaveLength(0);expect(db.products).toEqual(inventory().products);
 await expect(page.locator('.ad-card .ad-metrics')).toContainText('฿30');
 const form=await openSpend(page);await form.locator('[name="amount"]').fill('120');await form.locator('[name="note"]').fill('บิลรอบแรก');await form.locator('button').click();
 await expectSaved(page,db=>db.transactions.length===1);
 db=await snapshot(page);expect(db.transactions[0]).toMatchObject({amount:120,type:'expense',category:'ค่าโฆษณาสินค้า',adCampaignId:db.adCampaigns[0].id});
 expect(db.products).toEqual(inventory().products);
 await page.locator('[data-ad-product]').click();await expect(page.locator('#detail-body')).toContainText('กำไรสินค้าหลังหักแอด ฿-120');
 await page.locator('#detail-close-btn').click();
 await nav(page,'report');await expect(page.locator('#report-range-summary .val')).toHaveText(['฿0','฿120','฿-120','฿0','฿120','฿-120']);
 expect(errors).toEqual([]);
});

test('sale attribution records exactly once and computes net profit and the next ad reserve',async({page})=>{
 const errors=await boot(page,seeded({sales:false}));await nav(page,'sell');
 const card=page.locator('[data-sale-card]').first();await card.locator('.sell-ad-campaign').selectOption('ad-1');await card.locator('.sell-qty').fill('4');
 await expect(card.locator('.sell-ad-preview')).toContainText('฿480');
 await card.locator('.sell-submit').click();await expectSaved(page,db=>db.transactions.some(t=>t.adCampaignId==='ad-1'&&t.category==='ขายสินค้า'));
 const db=await snapshot(page);expect(db.products[0].variants[0].qty).toBe(6);expect(db.transactions.filter(t=>t.category==='ขายสินค้า')).toHaveLength(1);
 expect(db.transactions.find(t=>t.category==='ขายสินค้า')).toMatchObject({adCampaignId:'ad-1',profit:600,stockProductId:'product-1'});
 await nav(page,'ads');await expect(page.locator('.ad-reserve strong')).toHaveText('แนะนำแบ่งเก็บยิงแอดต่อ ฿80');
 await expect(page.locator('.ad-card .ad-metrics')).toContainText('5.00 เท่า');
 await nav(page,'report');await expect(page.locator('#report-range-summary .val')).toHaveText(['฿1,000','฿200','฿800','฿600','฿200','฿400']);
 expect(errors).toEqual([]);
});

test('unpaid installments cannot fund the next ads; new payments increase the cash-based reserve',async({page})=>{
 const state=seeded();state.transactions[0]=sale({type:'installment',paidAmount:100,dueDate:today(),adCampaignId:'ad-1'});
 await boot(page,state);await nav(page,'ads');await expect(page.locator('.ad-reserve strong')).toHaveText('แนะนำแบ่งเก็บยิงแอดต่อ ฿0');
 await expect(page.locator('.ad-reserve')).toContainText('฿-500');
 await nav(page,'installment');await page.locator('[data-pay]').click();await page.locator('#payment-amount').fill('900');await page.locator('#payment-submit-btn').click();
 await expectSaved(page,db=>db.transactions.find(t=>t.id==='sale-1').paidAmount===1000);
 await nav(page,'ads');await expect(page.locator('.ad-reserve strong')).toHaveText('แนะนำแบ่งเก็บยิงแอดต่อ ฿80');
});

test('historical sales link and unlink without duplicating costs or counting sales in two campaigns',async({page})=>{
 const state=seeded({sales:false});state.adCampaigns.push(campaign({id:'ad-2',name:'แคมเปญสอง'}));state.transactions.push(sale({}));
 await boot(page,state);await nav(page,'ads');const first=page.locator('[data-ad-id="ad-1"]');await first.locator('.ad-sales-details > summary').click();await first.locator('[name="transactionId"]').selectOption('sale-1');await first.locator('.ad-link-form button').click();
 await expectSaved(page,db=>db.transactions.find(t=>t.id==='sale-1').adCampaignId==='ad-1');
 await expect(page.locator('[data-ad-id="ad-2"] [name="transactionId"] option[value="sale-1"]')).toHaveCount(0);
 await first.locator('.ad-sales-details > summary').click();await first.locator('[data-ad-unlink]').click();await page.locator('#modal-ok-btn').click();
 await expectSaved(page,db=>!db.transactions.find(t=>t.id==='sale-1').adCampaignId);
 expect((await snapshot(page)).transactions).toHaveLength(2);expect((await snapshot(page)).products).toEqual(state.products);
});

test('campaign edits, dates, loss floor and spending correction preserve accounting consistency',async({page})=>{
 await boot(page,seeded());await nav(page,'ads');await page.locator('.ad-edit-details > summary').click();const form=page.locator('.ad-edit-form');
 await form.locator('[name="reservePercent"]').fill('30');await form.locator('[name="status"]').selectOption('completed');await form.locator('button').click();
 await expectSaved(page,db=>db.adCampaigns[0].reservePercent===30);await expect(page.locator('.ad-reserve strong')).toContainText('฿120');
 await page.locator('.ad-edit-details > summary').click();await form.locator('[name="startDate"]').fill('2030-01-02');await form.locator('[name="endDate"]').fill('2030-01-01');await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('กรุณาตรวจ');await page.locator('#modal-ok-btn').click();
 expect((await snapshot(page)).adCampaigns[0].startDate).toBe(today());
 // Reload the saved form instead of retaining the deliberately invalid edit.
 await nav(page,'home');await nav(page,'ads');let spending=await openSpend(page);await spending.locator('[name="amount"]').fill('500');await spending.locator('button').click();
 await expectSaved(page,db=>db.transactions.length===3);await expect(page.locator('.ad-warning').first()).toContainText('เกินงบ');await expect(page.locator('.ad-reserve strong')).toContainText('฿0');
 await openSpend(page);await page.locator('[data-ad-remove-spend]').first().click();await page.locator('#modal-ok-btn').click();await expectSaved(page,db=>db.transactions.length===2);await expect(page.locator('.ad-reserve strong')).toContainText('฿120');
});

test('failed and concurrent spending writes preserve the form and never duplicate the expense',async({page})=>{
 await boot(page,seeded({sales:false,spending:false}));await nav(page,'ads');const form=await openSpend(page);await form.locator('[name="amount"]').fill('75');
 await page.evaluate(()=>window.__testSaveError='offline');await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');await page.locator('#modal-ok-btn').click();await expect(form.locator('[name="amount"]')).toHaveValue('75');expect((await snapshot(page)).transactions).toHaveLength(0);
 await page.evaluate(()=>{delete window.__testSaveError;window.__testDB.transactions.push({id:'remote',type:'income',category:'อื่น',amount:1,date:'2026-01-01'});});await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('อุปกรณ์อื่น');await page.locator('#modal-ok-btn').click();
 await form.locator('button').click();await expectSaved(page,db=>db.transactions.length===2);expect((await snapshot(page)).transactions.filter(t=>t.adCampaignId)).toHaveLength(1);
});

test('stale edits and confirmations reject changed campaign or ledger records',async({page})=>{
 await boot(page,seeded());await nav(page,'ads');await page.locator('.ad-edit-details > summary').click();const form=page.locator('.ad-edit-form');await form.locator('[name="name"]').fill('ข้อมูลเก่า');
 await page.evaluate(()=>{window.__testDB.adCampaigns[0].name='ชื่อใหม่จากอีกเครื่อง';window.__testSubscribers.adCampaigns(structuredClone(window.__testDB.adCampaigns));});await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('แคมเปญเปลี่ยนแปลง');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).adCampaigns[0].name).toBe('ชื่อใหม่จากอีกเครื่อง');
 await nav(page,'home');await nav(page,'ads');await openSpend(page);await page.locator('[data-ad-remove-spend]').click();await page.evaluate(()=>{window.__testDB.transactions.find(t=>t.id==='spend-1').amount=225;window.__testSubscribers.transactions(structuredClone(window.__testDB.transactions));});await page.locator('#modal-ok-btn').click();await expect(page.locator('#modal-message')).toContainText('รายการบัญชีเปลี่ยนแปลง');expect((await snapshot(page)).transactions.find(t=>t.id==='spend-1').amount).toBe(225);
});

test('campaign backup round trips; malformed amounts, URLs and dangling attribution are rejected',async({page})=>{
 const state=seeded();await boot(page,state);await page.locator('.data-tools summary').click();const backup=JSON.parse(await exportText(page,'#export-btn'));expect(backup.version).toBe(9);expect(backup.adCampaigns).toEqual(state.adCampaigns);
 const upload=async payload=>page.locator('#import-input').setInputFiles({name:'ads.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(payload))});
 await upload(backup);await page.locator('#modal-ok-btn').click();await expectSaved(page,db=>db.adCampaigns[0].id==='ad-1');
 for(const mutate of [s=>s.adCampaigns[0].reservePercent=101,s=>s.adCampaigns[0].budget=-1,s=>s.adCampaigns[0].url='javascript:alert(1)',s=>s.transactions[0].adCampaignId='missing',s=>s.adCampaigns[0].productId='missing',s=>s.adCampaigns.push({...s.adCampaigns[0]})]) {
  const broken=structuredClone(backup);mutate(broken);await upload(broken);await expect(page.locator('#modal-message')).toContainText('ไม่ถูกต้อง');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).adCampaigns).toEqual(state.adCampaigns);
 }
});

test('ad expense is protected in general ledger and campaigns with history cannot be deleted',async({page})=>{
 await boot(page,seeded());await nav(page,'tx');await page.locator('[data-txdel="spend-1"]').click();await expect(page.locator('#modal-message')).toContainText('เมนูยิงแอด');await page.locator('#modal-ok-btn').click();
 await nav(page,'ads');await page.locator('.ad-edit-details > summary').click();await page.locator('[data-ad-delete]').click();await page.locator('#modal-ok-btn').click();await expect(page.locator('#modal-message')).toContainText('มีค่าใช้จ่ายหรือยอดขาย');expect((await snapshot(page)).adCampaigns).toHaveLength(1);
});

test('search, lifecycle filters and CSV use campaign attribution and escape spreadsheet formulas',async({page})=>{
 const state=seeded();state.adCampaigns.push(campaign({id:'ad-future',name:'=SUM(1,2)',startDate:'2099-01-01',endDate:'2099-01-03'}));await boot(page,state);await nav(page,'ads');await page.locator('#ad-filter').selectOption('scheduled');await expect(page.locator('[data-ad-id]:visible')).toHaveCount(1);const csv=await exportText(page,'#ad-export');expect(csv).toContain("'=SUM(1,2)");expect(csv).not.toContain('แอดเสื้อรอบแรก');
 await page.locator('#ad-filter').selectOption('all');await page.locator('#ad-search').fill('เสื้อรอบแรก');await expect(page.locator('[data-ad-id]:visible')).toHaveCount(1);
});

for(const width of [390,1440]) test(`ads forms and linked product detail fit ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:1000});const errors=await boot(page,seeded());await nav(page,'ads');
 await page.screenshot({path:`test-results/ads-${width}.png`,fullPage:true});
 for(const selector of ['#ad-create > summary','.ad-card details > summary']) {const elements=page.locator(selector);for(let i=0;i<await elements.count();i++)await elements.nth(i).click();}
 const size=await page.evaluate(()=>({w:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.w+1);
 await page.locator('[data-ad-product]').click();await expect(page.locator('.product-ad-detail')).toContainText('฿400');await page.locator('[data-product-ads]').click();await expect(page.locator('#ad-create-form [name="productId"]')).toHaveValue('product-1');
 expect(errors).toEqual([]);
});

test('ended and overspent campaigns appear in follow-ups and open the correct campaign',async({page})=>{
 const state=seeded({overrides:{endDate:'2020-01-01',startDate:'2020-01-01',budget:100}});await boot(page,state);await nav(page,'tasks');await page.locator('#task-filter').selectOption('ads');await expect(page.locator('[data-task-kind]:visible')).toHaveCount(1);await expect(page.locator('[data-task-kind]:visible')).toContainText('เกินงบ ฿100');await page.locator('[data-task-kind]:visible button').click();await expect(page.locator('[data-ad-id="ad-1"]')).toBeVisible();
});

test('product-level costs include every campaign, and reserve totals cannot exceed combined cash profit',async({page})=>{
 const state=seeded();state.adCampaigns.push(campaign({id:'ad-2',name:'แอดอีกรอบ',budget:500}));state.transactions.push(spend({id:'spend-2',amount:500,adCampaignId:'ad-2'}));await boot(page,state);await nav(page,'ads');await expect(page.locator('.ad-summary .val').last()).toHaveText('฿0');await page.locator('[data-ad-product]').first().click();await expect(page.locator('.product-ad-detail')).toContainText('กำไรสินค้าหลังหักแอด ฿-100');await expect(page.locator('.product-ad-detail')).toContainText('฿80');
});

test('a product cannot be deleted while a campaign is attached; unused campaigns can be deleted',async({page})=>{
 const state=seeded({sales:false,spending:false});state.products[0].variants.splice(1);await boot(page,state);await nav(page,'stock');await page.locator('[data-del="variant-1"]').click();await expect(page.locator('#modal-message')).toContainText('แคมเปญยิงแอด');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).products).toEqual(state.products);
 await nav(page,'ads');await page.locator('.ad-edit-details > summary').click();await page.locator('[data-ad-delete]').click();await page.locator('#modal-ok-btn').click();await expectSaved(page,db=>db.adCampaigns.length===0);expect((await snapshot(page)).products).toEqual(state.products);
});

test('ad validation rejects invalid future expenses and negative or fractional targets without writing',async({page})=>{
 await boot(page,seeded({sales:false,spending:false}));await nav(page,'ads');const form=await openSpend(page);await form.evaluate(el=>el.noValidate=true);await form.locator('[name="amount"]').fill('12');await form.locator('[name="date"]').fill('2099-01-01');await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('วันที่จ่ายไม่เกินวันนี้');await page.locator('#modal-ok-btn').click();
 await page.locator('.ad-edit-details > summary').click();const edit=page.locator('.ad-edit-form');await edit.evaluate(el=>el.noValidate=true);await edit.locator('[name="targetQty"]').fill('1.5');await edit.locator('button').click();await expect(page.locator('#modal-message')).toContainText('กรุณาตรวจ');expect((await snapshot(page)).transactions).toHaveLength(0);expect((await snapshot(page)).adCampaigns[0].targetQty).toBe(10);
});

test('inventory attaches a new campaign to the selected product and keeps it linked after rename',async({page})=>{
 const state=inventory();state.products.push({id:'product-2',name:'กางเกง',variants:[{id:'variant-3',color:'ดำ',size:'L',type:'new',qty:5,cost:100,price:250}]});await boot(page,state);await nav(page,'stock');await page.locator('#workspace-inventory [data-product-ads="product-2"]').click();const form=page.locator('#ad-create-form');await expect(form.locator('[name="productId"]')).toHaveValue('product-2');await form.locator('[name="name"]').fill('แอดกางเกง');await form.locator('[name="budget"]').fill('100');await form.locator('[name="targetQty"]').fill('5');await form.locator('[type="submit"]').click();await expectSaved(page,db=>db.adCampaigns?.[0]?.productId==='product-2');
 await page.evaluate(()=>{window.__testDB.products.find(p=>p.id==='product-2').name='กางเกงรุ่นใหม่';window.__testSubscribers.products(structuredClone(window.__testDB.products));});await expect(page.locator('.ad-card-header')).toContainText('กางเกงรุ่นใหม่');
});
