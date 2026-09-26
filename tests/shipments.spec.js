const {test,expect}=require('@playwright/test');
const {boot,nav,inventory,snapshot,expectSaved,today}=require('./helpers');
function seed() {
 const s=inventory();s.shipments=[];
 s.transactions=[{id:'sale-1',type:'income',category:'ขายสินค้า',desc:'เสื้อดำ M · อก 22.5 นิ้ว · ยาว 28 นิ้ว',date:today(),qty:3,amount:750,profit:450,productId:'variant-1',customerNote:'คุณเอ',deliveryStatus:'pending'},
 {id:'sale-2',type:'installment',category:'ขายสินค้า',desc:'เสื้อขาว L มือสอง',date:today(),qty:1,amount:200,profit:120,paidAmount:50,productId:'variant-2',customerNote:'คุณเอ',deliveryStatus:'pending'}];
 return s;
}
async function choose(page,id,qty) {
 const row=page.locator(`[data-pending-sale="${id}"]`);await row.locator('.shipment-select').check();if(qty!=null)await row.locator('.shipment-qty').fill(String(qty));
}
async function send(page) {await page.locator('#shipment-submit').click();await page.locator('#modal-ok-btn').click();}
async function download(page,selector) {const p=page.waitForEvent('download');await page.locator(selector).click();const chunks=[];for await(const c of await(await p).createReadStream())chunks.push(c);return Buffer.concat(chunks).toString();}

test('cash and installment checkout start pending; measured items stay distinct and shipping does not repeat accounting',async({page})=>{
 const s=inventory();s.products[0].variants[0].chestInches=22.5;s.products[0].variants[0].lengthInches=28;
 await boot(page,s);await nav(page,'sell');let card=page.locator('.sell-card').first();await card.locator('.sell-qty').fill('2');await card.locator('.sell-customer').fill('คุณเอ');await card.locator('.sell-submit').click();await expectSaved(page,s=>s.transactions.some(t=>t.deliveryStatus==='pending'));
 await card.locator('.sell-color-select').selectOption('ขาว');await card.locator('.sell-installment').check();await card.locator('.sell-deposit').fill('50');await card.locator('.sell-customer').fill('คุณเอ');await card.locator('.sell-submit').click();await expectSaved(page,s=>s.transactions.filter(t=>t.deliveryStatus==='pending').length===2);
 const before=await snapshot(page);await nav(page,'shipments');await expect(page.locator('[data-pending-sale]')).toHaveCount(2);await expect(page.locator('#shipment-form')).toContainText('อก 22.5 นิ้ว');await expect(page.locator('#shipment-form')).toContainText('ค้างชำระ ฿150');await page.locator('#shipment-select-all').check();await page.locator('#shipment-recipient').fill('คุณเอ');await page.locator('#shipment-tracking').fill('TRACK-123');await send(page);
 await expectSaved(page,s=>s.shipments?.length===1);const after=await snapshot(page);expect(after.shipments[0].items.reduce((a,i)=>a+i.qty,0)).toBe(3);expect(after.products).toEqual(before.products);expect(after.transactions.map(({deliveryStatus,...t})=>t)).toEqual(before.transactions.map(({deliveryStatus,...t})=>t));expect(after.transactions.filter(t=>t.deliveryStatus==='shipped')).toHaveLength(2);await expect(page.locator('[data-pending-sale]')).toHaveCount(0);await expect(page.locator('.shipment-history')).toContainText('TRACK-123');
});

test('partial shipments combine several sales, retain the remainder and can be cancelled without returning stock or money',async({page})=>{
 const s=seed();await boot(page,s);await nav(page,'shipments');await choose(page,'sale-1',2);await choose(page,'sale-2');await send(page);await expectSaved(page,s=>s.shipments.length===1);
 let db=await snapshot(page);expect(db.transactions[0].deliveryStatus).toBe('partial');expect(db.transactions[1].deliveryStatus).toBe('shipped');await expect(page.locator('[data-pending-sale="sale-1"]')).toContainText('เหลือส่ง 1 ชิ้น');await choose(page,'sale-1');await send(page);await expectSaved(page,s=>s.shipments.length===2);
 db=await snapshot(page);expect(db.transactions.every(t=>t.deliveryStatus==='shipped')).toBe(true);await page.locator('[data-shipment-cancel]').last().click();await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.shipments.some(p=>p.status==='cancelled'));
 db=await snapshot(page);expect(db.transactions[0].deliveryStatus).toBe('partial');expect(db.transactions[1].deliveryStatus).toBe('pending');expect(db.products).toEqual(s.products);expect(db.transactions.map(t=>t.amount)).toEqual(s.transactions.map(t=>t.amount));await expect(page.locator('[data-pending-sale="sale-1"]')).toContainText('เหลือส่ง 2 ชิ้น');await expect(page.locator('.shipment-history')).toContainText('ยกเลิกการบันทึกส่ง');
});

test('failed delivery saves keep selections and tracking; rapid repeated confirmation only creates one parcel',async({page})=>{
 await boot(page,seed());await nav(page,'shipments');await choose(page,'sale-1',1);await page.locator('#shipment-tracking').fill('KEEP-123');await page.evaluate(()=>window.__testSaveError='offline');await send(page);await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).shipments).toHaveLength(0);await expect(page.locator('#send-qty-sale-1')).toHaveValue('1');await expect(page.locator('#shipment-tracking')).toHaveValue('KEEP-123');await expect(page.locator('[data-pending-sale="sale-1"] .shipment-select')).toBeChecked();
 await page.evaluate(()=>{delete window.__testSaveError;window.__testSaveDelay=150;});await page.locator('#shipment-submit').click();await page.locator('#modal-ok-btn').click();await page.evaluate(()=>document.querySelector('#shipment-form')?.requestSubmit());await expectSaved(page,s=>s.shipments.length===1);expect((await snapshot(page)).shipments[0].items).toEqual([{saleId:'sale-1',qty:1}]);
});

test('another device shipping during confirmation cannot be overwritten or shipped twice',async({page})=>{
 await boot(page,seed());await nav(page,'shipments');await choose(page,'sale-1');await page.locator('#shipment-submit').click();
 await page.evaluate(date=>{window.__testDB.transactions[0].deliveryStatus='shipped';window.__testDB.shipments=[{id:'remote',status:'shipped',date,recipient:'',carrier:'',trackingNumber:'REMOTE',note:'',items:[{saleId:'sale-1',qty:3}]}];window.__testSubscribers.transactions(structuredClone(window.__testDB.transactions));window.__testSubscribers.shipments(structuredClone(window.__testDB.shipments));},today());
 await page.locator('#modal-ok-btn').click();await expect(page.locator('#modal-message')).toContainText('เปลี่ยนแปลง');expect((await snapshot(page)).shipments.map(p=>p.id)).toEqual(['remote']);
});

test('invalid shipping quantities and dates are rejected before any mutations even without native validation',async({page})=>{
 await boot(page,seed());await nav(page,'shipments');await choose(page,'sale-1');await page.locator('#shipment-form').evaluate(f=>f.noValidate=true);
 for(const qty of ['0','-1','1.5','4']) {await page.locator('#send-qty-sale-1').fill(qty);await send(page);await expect(page.locator('#modal-message')).toContainText('จำนวนที่จะส่ง');await page.locator('#modal-ok-btn').click();}
 await page.locator('#send-qty-sale-1').fill('1');for(const date of ['2099-01-01','2000-01-01']) {await page.locator('#shipment-date').fill(date);await send(page);await expect(page.locator('#modal-message')).toContainText('วันที่ส่ง');await page.locator('#modal-ok-btn').click();}
 expect((await snapshot(page)).shipments).toHaveLength(0);expect((await snapshot(page)).transactions[0].deliveryStatus).toBe('pending');
});

test('followups exclude single and sold out used stock but include new stock and pending shipments',async({page})=>{
 const s=seed();s.products[0].variants=[{...s.products[0].variants[0],qty:1},{...s.products[0].variants[0],id:'new-zero',qty:0},{...s.products[0].variants[1],qty:1},{...s.products[0].variants[1],id:'used-zero',qty:0}];
 await boot(page,s);await nav(page,'tasks');await page.locator('#task-filter').selectOption('stock');await expect(page.locator('[data-task-kind="stock"]')).toHaveCount(2);await expect(page.locator('[data-task-kind="stock"]').first()).toContainText('มือหนึ่ง');await expect(page.locator('[data-task-kind="stock"]').last()).toContainText('มือหนึ่ง');
 await page.locator('#task-filter').selectOption('shipment');await expect(page.locator('[data-task-kind="shipment"]:visible')).toHaveCount(2);await page.locator('[data-task-kind="shipment"]:visible button').first().click();await expect(page.locator('[data-pending-sale]:visible')).toHaveCount(1);
});

test('legacy sales stay outside the queue and account deletion cannot orphan shipping history',async({page})=>{
 const s=seed();s.transactions.push({...s.transactions[0],id:'legacy',deliveryStatus:undefined});await boot(page,s);await nav(page,'shipments');await expect(page.locator('[data-pending-sale]')).toHaveCount(2);await choose(page,'sale-1');await send(page);await expectSaved(page,s=>s.shipments.length===1);
 await nav(page,'tx');await page.locator('[data-txdel="sale-1"]').click();await expect(page.locator('#modal-message')).toContainText('ประวัติการจัดส่ง');expect((await snapshot(page)).transactions).toHaveLength(3);
});

test('shipment backups round trip; inconsistent totals, missing sales and forged status are rejected',async({page})=>{
 await boot(page,seed());await nav(page,'shipments');await choose(page,'sale-1',2);await page.locator('#shipment-recipient').fill('=ผู้รับ');await send(page);await expectSaved(page,s=>s.shipments.length===1);expect(await download(page,'#shipment-export')).toContain("'=ผู้รับ");
 await page.locator('.data-tools summary').click();const backup=JSON.parse(await download(page,'#export-btn'));expect(backup.version).toBe(9);const upload=data=>page.locator('#import-input').setInputFiles({name:'shipping.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 await upload(backup);await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.shipments.length===1);
 for(const mutate of [b=>b.shipments[0].items[0].qty=4,b=>b.shipments[0].items[0].saleId='missing',b=>b.transactions[0].deliveryStatus='shipped',b=>b.shipments[0].items.push({...b.shipments[0].items[0]}),b=>b.shipments[0].date='bad']) {const bad=structuredClone(backup);mutate(bad);await upload(bad);await expect(page.locator('#modal-message')).toContainText('ไม่ถูกต้อง');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).shipments).toEqual(backup.shipments);}
 await upload(inventory());await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.shipments.length===0);
});

for(const width of [390,1440]) test(`shipment selection and parcel history fit ${width}px and keep hidden selections explicit`,async({page})=>{
 await page.setViewportSize({width,height:900});const errors=await boot(page,seed());await nav(page,'shipments');await choose(page,'sale-1');await page.locator('#shipment-search').fill('ขาว');await expect(page.locator('#shipment-selection-summary')).toContainText('นอกผลค้นหา');await page.locator('#shipment-select-all').check();await expect(page.locator('#shipment-selection-summary')).toContainText('เลือก 2 รายการ');await page.locator('#shipment-clear').click();await expect(page.locator('#shipment-submit')).toBeDisabled();await page.locator('#shipment-search').fill('');await page.locator('#shipment-select-all').check();await page.locator('#shipment-recipient').fill('<img src=x onerror=alert(1)>');await page.locator('#shipment-carrier').fill('ไปรษณีย์ไทย');await page.locator('#shipment-tracking').fill('TH123456789');await page.locator('#shipment-form').screenshot({path:`test-results/shipment-form-${width}.png`});await send(page);await expectSaved(page,s=>s.shipments.length===1);await expect(page.locator('.shipment-history img')).toHaveCount(0);await page.locator('.shipment-history').screenshot({path:`test-results/shipment-history-${width}.png`});
 const d=await page.evaluate(()=>({w:document.documentElement.clientWidth,s:document.documentElement.scrollWidth}));expect(d.s).toBeLessThanOrEqual(d.w+1);expect(errors).toEqual([]);
});
