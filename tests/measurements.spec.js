const {test,expect}=require('@playwright/test');
const {boot,nav,radio,inventory,snapshot,expectSaved}=require('./helpers');
function measured(){const s=inventory();s.products[0].variants=[{...s.products[0].variants[0],type:'used',qty:2,chestInches:22.5,lengthInches:28},{...s.products[0].variants[0],id:'variant-2',type:'used',qty:1,chestInches:23,lengthInches:29}];return s;}
async function mode(page,value='new'){await nav(page,'stock');await page.locator('[data-workspace-tab="add"]').click();await radio(page,`[name="mode"][value="${value}"]`);}
async function rowFill(row,chest,length,qty='1'){await row.locator('.pbRowColor').fill('ดำ');await row.locator('.pbRowSize').fill('M');await row.locator('.pbRowQty').fill(qty);await row.locator('.pbRowChest').fill(chest);await row.locator('.pbRowLength').fill(length);}
async function fillNew(page){await page.locator('.pb-name').fill('เสื้อมือสอง');await radio(page,'.pb-type-toggle [value="used"]');await page.locator('.pb-price').fill('250');await page.locator('.pb-cost-perunit').fill('100');await rowFill(page.locator('.pb-size-row').first(),'22.5','28');}
async function download(page,selector){const p=page.waitForEvent('download');await page.locator(selector).click();const chunks=[];for await(const c of await (await p).createReadStream())chunks.push(c);return Buffer.concat(chunks).toString();}

test('each size row shows its own measurements and explicitly identifies missing dimensions', async ({page}) => {
 const s = measured();
 s.products[0].variants.push({...s.products[0].variants[0], id:'unmeasured', chestInches:null, lengthInches:null});
 s.products[0].variants.push({...s.products[0].variants[0], id:'partial', qty:0, chestInches:24, lengthInches:null});
 await boot(page,s);
 await nav(page,'stock');
 for (const [id,chest,length] of [['variant-1','22.5 นิ้ว','28 นิ้ว'],['variant-2','23 นิ้ว','29 นิ้ว'],['unmeasured','ยังไม่ระบุ','ยังไม่ระบุ'],['partial','24 นิ้ว','ยังไม่ระบุ']]) {
   const row = page.locator(`[data-stock-variant="${id}"]`);
   await expect(row).toContainText('ไซส์ M');
   await expect(row.locator('.size-measurements')).toContainText(`อก ${chest}`);
   await expect(row.locator('.size-measurements')).toContainText(`ยาว ${length}`);
 }
 await nav(page,'home');
 await expect(page.locator('.variant-row').filter({hasText:'อก 22.5 นิ้ว'})).toContainText('ยาว 28 นิ้ว');
 await expect(page.locator('.variant-row').filter({hasText:'อก 23 นิ้ว'})).toContainText('ยาว 29 นิ้ว');
 await expect(page.locator('.variant-row').filter({hasText:'อก 24 นิ้ว'})).toContainText('ยาว ยังไม่ระบุ');
});

test('same used tag size supports different actual measurements while identical measurements combine',async({page})=>{
 const errors=await boot(page,{products:[],transactions:[],pendingOrders:[]});await mode(page);await fillNew(page);
 for(const [chest,length] of [['23','29'],['22.50','28'],['','']]){await page.locator('.add-pb-size-row').click();await rowFill(page.locator('.pb-size-row').last(),chest,length);}
 await page.locator('#add-product-submit').click();await expectSaved(page,s=>s.products[0]?.variants.length===3);const s=await snapshot(page);expect(s.products[0].variants.find(v=>v.chestInches===22.5)).toMatchObject({qty:2,lengthInches:28});expect(s.products[0].variants.find(v=>v.chestInches===23)).toMatchObject({qty:1,lengthInches:29});expect(s.products[0].variants.find(v=>v.chestInches==null).qty).toBe(1);expect(s.transactions.reduce((a,t)=>a+t.amount,0)).toBe(400);await page.locator('[data-workspace-tab="inventory"]').click();await expect(page.locator('#workspace-inventory')).toContainText('อก 22.5 นิ้ว');expect(errors).toEqual([]);
});

test('restocking an existing measured item preserves its identity; new measurements create another option',async({page})=>{
 await boot(page,measured());await mode(page,'restock');await page.locator('.restock-variant').selectOption('variant-1');await page.locator('.restock-qty').fill('1');await page.locator('.add-restock-option').click();const row=page.locator('[data-new-option="true"]');await row.locator('.restock-size').fill('M');await row.locator('.restockChest').fill('22.5');await row.locator('.restockLength').fill('30');await page.locator('#add-product-submit').click();await expectSaved(page,s=>s.products[0].variants.length===3);const s=await snapshot(page);expect(s.products[0].variants.find(v=>v.id==='variant-1')).toMatchObject({qty:3,chestInches:22.5,lengthInches:28});expect(s.products[0].variants.find(v=>v.lengthInches===30).qty).toBe(1);
});

test('merge only combines exact measured options and does not merge unknown measurements with known ones',async({page})=>{
 const s=measured();s.products.push({...s.products[0],id:'duplicate',variants:[{...s.products[0].variants[0],id:'duplicate-same',qty:1},{...s.products[0].variants[0],id:'unknown',qty:1,chestInches:null,lengthInches:null}]});await boot(page,s);await nav(page,'stock');await page.locator('#merge-data-btn').click();await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.products.length===1);const variants=(await snapshot(page)).products[0].variants;expect(variants).toHaveLength(3);expect(variants.find(v=>v.id==='variant-1').qty).toBe(3);expect(variants.find(v=>v.chestInches===23).qty).toBe(1);expect(variants.find(v=>v.chestInches==null).qty).toBe(1);
});

test('supplier orders preserve actual measurements through receiving without merging same tag sizes',async({page})=>{
 const s=measured();await boot(page,s);await mode(page,'pending');await page.locator('.pRowProduct').selectOption('product-1');await page.locator('.pRowColor').fill('ดำ');await page.locator('.pRowSize').fill('M');await radio(page,'.pending-row-type [value="used"]');await page.locator('.pRowQty').fill('1');await page.locator('.pRowCost').fill('100');await page.locator('.pRowPrice').fill('250');await page.locator('.pRowChest').fill('24');await page.locator('.pRowLength').fill('30.25');await page.locator('#add-product-submit').click();await expectSaved(page,s=>s.pendingOrders.length===1);expect((await snapshot(page)).products).toEqual(s.products);await page.locator('[data-workspace-tab="pending"]').click();await expect(page.locator('#workspace-pending')).toContainText('อก 24 นิ้ว');await page.locator('.pending-select').check();await page.locator('#pending-receive-selected').click();await expectSaved(page,s=>s.pendingOrders.length===0);expect((await snapshot(page)).products[0].variants).toHaveLength(3);expect((await snapshot(page)).products[0].variants.find(v=>v.chestInches===24)).toMatchObject({lengthInches:30.25,qty:1});
});

test('edit allows the same tag size with distinct measurements but rejects exact duplicates and invalid inches',async({page})=>{
 await boot(page,measured());await nav(page,'stock');await page.locator('[data-edit="variant-2"]').click();const f=page.locator('#edit-form');await expect(f.locator('[name="chestInches"]')).toHaveValue('23');await f.locator('[name="chestInches"]').fill('22.5');await f.locator('[name="lengthInches"]').fill('28');await f.locator('[type="submit"]').click();await expect(page.locator('#modal-message')).toContainText('ขนาดจริงตรงกัน');await page.locator('#modal-ok-btn').click();await f.locator('[name="lengthInches"]').fill('28.5');await f.locator('[type="submit"]').click();await expectSaved(page,s=>s.products[0].variants[1].lengthInches===28.5);
 await page.locator('[data-edit="variant-2"]').click();await f.evaluate(el=>el.noValidate=true);await f.locator('[name="chestInches"]').fill('-1');await f.locator('[type="submit"]').click();await expect(page.locator('#modal-message')).toContainText('0.01–300');expect((await snapshot(page)).products[0].variants[1].chestInches).toBe(22.5);
});

test('checkout identifies the measured item and retains the measurements on the sale after an edit',async({page})=>{
 await boot(page,measured());await nav(page,'sell');const card=page.locator('[data-sale-card]').first();await expect(card.locator('.sell-size-select')).toContainText('อก 23 นิ้ว');await card.locator('.sell-size-select').selectOption('variant-2');await card.locator('.sell-submit').click();await expectSaved(page,s=>s.transactions.some(t=>t.category==='ขายสินค้า'));let s=await snapshot(page);expect(s.products[0].variants.map(v=>v.qty)).toEqual([2,0]);const sale=s.transactions.find(t=>t.category==='ขายสินค้า');expect(sale).toMatchObject({chestInches:23,lengthInches:29});expect(sale.desc).toContain('ยาว 29 นิ้ว');await nav(page,'stock');await page.locator('[data-edit="variant-2"]').click();await page.locator('#edit-form [name="lengthInches"]').fill('29.5');await page.locator('#edit-form [type="submit"]').click();await expectSaved(page,s=>s.products[0].variants[1].lengthInches===29.5);expect((await snapshot(page)).transactions.find(t=>t.id===sale.id).lengthInches).toBe(29);
});

test('failed measured item creation retains input and invalid later rows cannot partly save a batch',async({page})=>{
 await boot(page,{products:[],transactions:[],pendingOrders:[]});await mode(page);await fillNew(page);await page.locator('.add-pb-size-row').click();await rowFill(page.locator('.pb-size-row').last(),'0','28');await page.locator('#add-product-submit').click();await expect(page.locator('#modal-message')).toContainText('อกและความยาว');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).products).toHaveLength(0);await page.locator('.pbRowChest').last().fill('23');await page.evaluate(()=>window.__testSaveError='offline');await page.locator('#add-product-submit').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');await page.locator('#modal-ok-btn').click();await expect(page.locator('.pbRowChest').first()).toHaveValue('22.5');await page.evaluate(()=>delete window.__testSaveError);await page.locator('#add-product-submit').click();await expectSaved(page,s=>s.products[0]?.variants.length===2);
});

test('stock search CSV and backup preserve inches and reject malformed imported measurements',async({page})=>{
 await boot(page,measured());await nav(page,'stock');await page.locator('#stock-search').fill('อก 22.5');await expect(page.locator('[data-stock-variant]:visible')).toHaveCount(1);const csv=await download(page,'#stock-export-filtered');expect(csv).toContain('อก (นิ้ว)');expect(csv).toContain('22.5');expect(csv).not.toContain('variant-2');await page.locator('.data-tools summary').click();const backup=JSON.parse(await download(page,'#export-btn'));expect(backup.version).toBe(9);const upload=async data=>page.locator('#import-input').setInputFiles({name:'measurements.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});await upload(backup);await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.products[0].variants[0].chestInches===22.5);
 for(const invalid of [-1,0,301,22.123,'22']){const bad=structuredClone(backup);bad.products[0].variants[0].chestInches=invalid;await upload(bad);await expect(page.locator('#modal-message')).toContainText('ไม่ถูกต้อง');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).products[0].variants[0].chestInches).toBe(22.5);}
});

for(const width of [390,1440]) test(`measurement forms and same-size options fit ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});const errors=await boot(page,measured());await mode(page);await fillNew(page);await page.screenshot({path:`test-results/measurements-form-${width}.png`,fullPage:true});const box=await page.locator('.pbRowChest').boundingBox();expect(box.height).toBeLessThan(65);await page.locator('[data-workspace-tab="inventory"]').click();await page.screenshot({path:`test-results/measurements-stock-${width}.png`,fullPage:true});await nav(page,'sell');await expect(page.locator('.sell-size-select')).toContainText('อก 22.5 นิ้ว');const d=await page.evaluate(()=>({w:document.documentElement.clientWidth,s:document.documentElement.scrollWidth}));expect(d.s).toBeLessThanOrEqual(d.w+1);expect(errors).toEqual([]);
});
