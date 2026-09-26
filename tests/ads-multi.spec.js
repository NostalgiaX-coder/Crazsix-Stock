const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');
function seed() {
 const s=inventory();s.products.push({id:'product-2',name:'กางเกง',variants:[{id:'variant-3',color:'ดำ',size:'L',type:'new',qty:10,cost:100,price:250}]});
 s.adCampaigns=[];return s;
}
const legacy = () => ({id:'ad-1',productId:'product-1',name:'แอดเดิม',channel:'Facebook',status:'active',startDate:today(),endDate:today(),budget:500,targetQty:10,reservePercent:20,url:'',note:''});
async function create(page) {
 await nav(page,'ads');const f=page.locator('#ad-create-form');await f.locator('[name="name"]').fill('แอดรวมหลายสินค้า');await f.locator('[name="productId"]').selectOption('product-1');await f.locator('[name="extraProductId"][value="product-2"]').check();await f.locator('[name="budget"]').fill('100');await f.locator('[name="targetQty"]').fill('10');await f.locator('[type="submit"]').click();await expectSaved(page,db=>db.adCampaigns.length===1);
}
async function spend(page,amount) {
 await page.locator('.ad-spend-details > summary').click();await page.locator('.ad-spend-form [name="amount"]').fill(amount);await page.locator('.ad-spend-form button').click();await expectSaved(page,db=>db.transactions.some(t=>t.type==='expense'&&t.amount===Number(amount)));
}
async function metrics(page) {
 return page.evaluate(async()=>{const {productAdMetrics,adMetrics}=await import('/js/ads.js');const s=window.__testDB;return {products:s.products.map(p=>productAdMetrics(p,s.adCampaigns,s.transactions,new Date().toISOString().slice(0,10))),campaign:adMetrics(s.adCampaigns[0],s.transactions,new Date().toISOString().slice(0,10))};});
}

test('an ongoing campaign has no end date, tracks budget exhaustion and resumes after increasing budget',async({page})=>{
 const errors=await boot(page,seed());await create(page);let db=await snapshot(page);expect(db.adCampaigns[0]).toMatchObject({runMode:'until_budget',endDate:'',productIds:['product-1','product-2']});
 await expect(page.locator('.ad-card-header')).toContainText('ไม่กำหนดวันสิ้นสุด');await expect(page.locator('.ad-card-header')).not.toContainText('/วัน');
 await spend(page,'100');await expect(page.locator('[data-ad-phase="exhausted"]')).toBeVisible();await expect(page.locator('.ad-warning')).toContainText('ไม่ได้สั่งหยุดโฆษณาให้อัตโนมัติ');
 await nav(page,'tasks');await page.locator('#task-filter').selectOption('ads');await expect(page.locator('[data-task-kind="ads"]')).toContainText('ใช้งบครบแล้ว');await expect(page.locator('[data-task-kind="ads"]')).not.toContainText('ครบกำหนดแคมเปญ');
 await nav(page,'ads');await page.locator('.ad-edit-details > summary').click();await page.locator('.ad-edit-form [name="budget"]').fill('200');await page.locator('.ad-edit-form button').click();await expect(page.locator('[data-ad-phase="active"]')).toBeVisible();expect(errors).toEqual([]);
});

test('multi-product costs split to exact cents and sales remain specific to each product',async({page})=>{
 const state=seed();state.transactions=[{id:'sale-a',type:'income',category:'ขายสินค้า',date:today(),amount:250,profit:150,qty:1,productId:'variant-1'}, {id:'sale-b',type:'income',category:'ขายสินค้า',date:today(),amount:250,profit:150,qty:1,productId:'variant-3'}];
 await boot(page,state);await create(page);await spend(page,'10.01');let db=await snapshot(page);expect(db.transactions[0].adAllocations).toEqual([{productId:'product-1',amount:5.01},{productId:'product-2',amount:5}]);
 for(const id of ['sale-a','sale-b']) {await page.locator('.ad-sales-details > summary').click();await page.locator('.ad-link-form select').selectOption(id);await page.locator('.ad-link-form button').click();await expectSaved(page,db=>db.transactions.find(t=>t.id===id).adCampaignId);}
 const m=await metrics(page);expect(m.products.map(p=>p.spend)).toEqual([5.01,5]);expect(m.products.map(p=>p.profit)).toEqual([150,150]);expect(m.products.map(p=>p.net)).toEqual([144.99,145]);expect(m.campaign.net).toBe(289.99);expect(db.products).toEqual(state.products);
 await nav(page,'sell');const pants=page.locator('[data-sale-card]').filter({has:page.locator('.sell-name',{hasText:'กางเกง'})});await pants.locator('.sell-ad-campaign').selectOption(db.adCampaigns[0].id);await pants.locator('.sell-submit').click();await expectSaved(page,db=>db.transactions.filter(t=>t.category==='ขายสินค้า').length===3);
 await nav(page,'ads');await page.locator('[data-ad-product="product-2"]').click();await expect(page.locator('.product-ad-detail')).toContainText('กำไรสินค้าหลังหักแอด ฿295');
});

test('adding a product to a legacy campaign preserves historical allocations and only splits subsequent spending',async({page})=>{
 const state=seed();state.adCampaigns=[legacy()];state.transactions=[{id:'old-spend',type:'expense',category:'ค่าโฆษณาสินค้า',date:today(),amount:200,adCampaignId:'ad-1'}];await boot(page,state);await nav(page,'ads');await page.locator('.ad-edit-details > summary').click();const f=page.locator('.ad-edit-form');await f.locator('[name="extraProductId"][value="product-2"]').check();await f.locator('[name="runMode"]').selectOption('until_budget');await f.locator('button').click();await expectSaved(page,db=>db.adCampaigns[0].productIds?.length===2);
 expect((await snapshot(page)).transactions[0].adAllocations).toEqual([{productId:'product-1',amount:200}]);await spend(page,'100');const m=await metrics(page);expect(m.products.map(p=>p.spend)).toEqual([250,50]);expect(m.campaign.spend).toBe(300);
 await page.locator('.ad-edit-details > summary').click();await f.locator('[name="extraProductId"][value="product-2"]').uncheck();await f.locator('button').click();await expect(page.locator('#modal-message')).toContainText('ไม่สามารถนำออกได้');expect((await snapshot(page)).adCampaigns[0].productIds).toHaveLength(2);
});

test('switching run modes requires a valid end date only for dated campaigns',async({page})=>{
 await boot(page,seed());await nav(page,'ads');const f=page.locator('#ad-create-form');await expect(f.locator('[name="endDate"]')).toBeDisabled();await expect(f.locator('.ad-end-field')).toBeHidden();await f.locator('[name="runMode"]').selectOption('dated');await expect(f.locator('[name="endDate"]')).toBeEnabled();await f.locator('[name="name"]').fill('แอดมีวันจบ');await f.locator('[name="productId"]').selectOption('product-1');await f.locator('[name="budget"]').fill('100');await f.locator('[name="targetQty"]').fill('10');await f.locator('[name="startDate"]').fill('2030-02-02');await f.locator('[name="endDate"]').fill('2030-02-01');await f.locator('button').click();await expect(page.locator('#modal-message')).toContainText('กรุณาตรวจ');await page.locator('#modal-ok-btn').click();await f.locator('[name="runMode"]').selectOption('until_budget');await f.locator('button').click();await expectSaved(page,db=>db.adCampaigns.length===1);await expect(page.locator('[data-ad-phase="scheduled"]')).toBeVisible();
});

test('backup validates multi-product memberships and exact expense allocations',async({page})=>{
 await boot(page,seed());await create(page);await spend(page,'100');const good=await snapshot(page);const upload=async data=>page.locator('#import-input').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await upload(good);await page.locator('#modal-ok-btn').click();await expectSaved(page,db=>db.transactions.length===1);
 for(const mutate of [s=>s.adCampaigns[0].productIds.push('product-2'),s=>s.adCampaigns[0].productIds.push('missing'),s=>s.transactions[0].adAllocations[0].amount=75,s=>delete s.transactions[0].adAllocations,s=>s.transactions[0].adAllocations[0].productId='missing']) {const bad=structuredClone(good);mutate(bad);await upload(bad);await expect(page.locator('#modal-message')).toContainText('ไม่ถูกต้อง');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).transactions).toEqual(good.transactions);}
});

for(const width of [390,1440]) test(`multiple attached products and ongoing controls fit ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});const errors=await boot(page,seed());await create(page);await spend(page,'5');await page.locator('.ad-card details').first().locator('summary').click();await page.locator('.ad-edit-details > summary').click();await page.screenshot({path:`test-results/ads-multi-${width}.png`,fullPage:true});const d=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));expect(d.scroll).toBeLessThanOrEqual(d.width+1);await expect(page.locator('[data-ad-product]')).toHaveCount(2);expect(errors).toEqual([]);
});

test('merging duplicate inventory combines campaign memberships and allocations without losing a cent',async({page})=>{
 const state=seed();state.products[1].name=state.products[0].name;state.adCampaigns=[{...legacy(),productIds:['product-1','product-2']}];state.transactions=[{id:'spend',type:'expense',category:'ค่าโฆษณาสินค้า',date:today(),amount:10.01,adCampaignId:'ad-1',adAllocations:[{productId:'product-1',amount:5.01},{productId:'product-2',amount:5}]}];
 await boot(page,state);await nav(page,'stock');await page.locator('#merge-data-btn').click();await page.locator('#modal-ok-btn').click();await expectSaved(page,db=>db.products.length===1);const db=await snapshot(page);expect(db.adCampaigns[0].productIds).toEqual([db.products[0].id]);expect(db.transactions[0].adAllocations).toEqual([{productId:db.products[0].id,amount:10.01}]);const m=await metrics(page);expect(m.products[0].spend).toBe(10.01);
});

test('failed edits cannot reallocate historical costs and retry safely adds the second product',async({page})=>{
 const state=seed();state.adCampaigns=[legacy()];state.transactions=[{id:'spend',type:'expense',category:'ค่าโฆษณาสินค้า',date:today(),amount:100,adCampaignId:'ad-1'}];await boot(page,state);await nav(page,'ads');await page.locator('.ad-edit-details > summary').click();await page.locator('.ad-edit-form [name="extraProductId"][value="product-2"]').check();await page.evaluate(()=>window.__testSaveError='offline');await page.locator('.ad-edit-form button').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).transactions).toEqual(state.transactions);expect((await snapshot(page)).adCampaigns).toEqual(state.adCampaigns);await page.evaluate(()=>delete window.__testSaveError);await page.locator('.ad-edit-form button').click();await expectSaved(page,db=>db.adCampaigns[0].productIds?.length===2);expect((await metrics(page)).products.map(p=>p.spend)).toEqual([100,0]);
});
