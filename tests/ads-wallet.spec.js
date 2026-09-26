const {test,expect}=require('@playwright/test');
const {boot,nav,inventory,snapshot,expectSaved,today}=require('./helpers');
function seed() {
 const s=inventory();
 s.adCampaigns=[{id:'ad-1',name:'แอดเสื้อ',productId:'product-1',channel:'Facebook',status:'active',startDate:today(),endDate:'',runMode:'until_budget',budget:1000,dailyBudget:100,targetQty:10,reservePercent:20,note:'',url:''}];
 s.adWallet=[];
 return s;
}
async function topup(page,amount='500') {
 await page.locator('.ad-wallet-details > summary').click();
 const form=page.locator('#ad-topup-form');
 await form.locator('[name="amount"]').fill(amount);
 await form.locator('[name="note"]').fill('รอบเติมเงิน');
 return form;
}
async function spend(page,amount,source='wallet',id='ad-1') {
 const card=page.locator(`[data-ad-id="${id}"]`);
 await card.locator('.ad-spend-details > summary').click();
 const form=card.locator('.ad-spend-form');
 await form.locator('[name="amount"]').fill(amount);
 await form.locator('[name="paymentSource"]').selectOption(source);
 await form.locator('button').click();
}
async function download(page,selector) {
 const waiting=page.waitForEvent('download');await page.locator(selector).click();
 const chunks=[];for await(const chunk of await(await waiting).createReadStream())chunks.push(chunk);
 return Buffer.concat(chunks).toString();
}

test('topups can precede products and new campaigns retain a daily budget',async({page})=>{
 const s=seed();s.adCampaigns=[];s.products=[];await boot(page,s);await nav(page,'ads');
 const form=await topup(page,'250');await form.locator('button').click();await expectSaved(page,s=>s.adWallet.length===1);
 await page.evaluate(products=>{window.__testDB.products=products;window.__testSubscribers.products(structuredClone(products));},inventory().products);
 await nav(page,'home');await nav(page,'ads');const create=page.locator('#ad-create-form');
 await create.locator('[name="name"]').fill('แอดต่อเนื่อง');await create.locator('[name="productId"]').selectOption('product-1');await create.locator('[name="budget"]').fill('500');await create.locator('[name="dailyBudget"]').fill('50');await create.locator('[name="targetQty"]').fill('10');await create.locator('button').click();
 await expectSaved(page,s=>s.adCampaigns[0]?.dailyBudget===50);expect((await snapshot(page)).adWallet[0].amount).toBe(250);expect((await snapshot(page)).transactions).toHaveLength(0);
});

test('daily budgets estimate duration, persist edits and remain optional for old campaigns',async({page})=>{
 const s=seed();delete s.adCampaigns[0].dailyBudget;await boot(page,s);await nav(page,'ads');
 await expect(page.locator('.ad-metrics').last()).toContainText('ระบุงบต่อวันก่อน');
 await page.locator('.ad-edit-details > summary').click();const form=page.locator('.ad-edit-form');
 await form.locator('[name="dailyBudget"]').fill('125');await expect(form.locator('.ad-plan-preview')).toContainText('8 วัน');
 await form.locator('button').click();await expectSaved(page,s=>s.adCampaigns[0].dailyBudget===125);
 expect((await snapshot(page)).transactions).toHaveLength(0);
 await expect(page.locator('.ad-metrics').last()).toContainText('8 วัน');
 await spend(page,'250','direct');await expectSaved(page,s=>s.transactions.length===1);
 await expect(page.locator('.ad-metrics').last()).toContainText('6 วัน');
 await expect(page.locator('.ad-metrics').last()).toContainText('ค่าแอดใช้จริงวันนี้฿250');
 await page.locator('.ad-edit-details > summary').click();await form.locator('[name="dailyBudget"]').fill('');await form.locator('button').click();
 await expectSaved(page,s=>s.adCampaigns[0].dailyBudget===null);
});

test('shared topups do not double count expenses, funded spend reduces credit and direct spend does not',async({page})=>{
 const s=seed();s.adCampaigns.push({...s.adCampaigns[0],id:'ad-2',name:'แอดอีกตัว'});
 await boot(page,s);await nav(page,'ads');let form=await topup(page);await form.locator('button').click();await expectSaved(page,s=>s.adWallet.length===1);
 form=await topup(page,'200');await form.locator('button').click();await expectSaved(page,s=>s.adWallet.length===2);
 expect((await snapshot(page)).transactions).toHaveLength(0);expect((await snapshot(page)).adCampaigns[0].budget).toBe(1000);
 await spend(page,'100');await expectSaved(page,s=>s.transactions.length===1);
 await spend(page,'50','wallet','ad-2');await expectSaved(page,s=>s.transactions.length===2);
 await spend(page,'30','direct');await expectSaved(page,s=>s.transactions.length===3);
 await expect(page.locator('[data-wallet-balance]')).toHaveText('฿550');
 await expect(page.locator('[data-wallet-spent]')).toHaveText('฿150');
 expect((await snapshot(page)).transactions.reduce((a,t)=>a+t.amount,0)).toBe(180);
 const card=page.locator('[data-ad-id="ad-2"]');await card.locator('.ad-spend-details > summary').click();await card.locator('[data-ad-remove-spend]').click();await page.locator('#modal-ok-btn').click();
 await expectSaved(page,s=>s.transactions.length===2);await expect(page.locator('[data-wallet-balance]')).toHaveText('฿600');
});

test('topup failure and rapid resubmission preserve the form and add exactly once',async({page})=>{
 await boot(page,seed());await nav(page,'ads');const form=await topup(page,'123.45');
 await page.evaluate(()=>window.__testSaveError='offline');await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');await page.locator('#modal-ok-btn').click();
 expect((await snapshot(page)).adWallet).toHaveLength(0);await expect(form.locator('[name="amount"]')).toHaveValue('123.45');
 await page.evaluate(()=>{delete window.__testSaveError;window.__testSaveDelay=100;document.querySelector('#ad-topup-form').requestSubmit();document.querySelector('#ad-topup-form').requestSubmit();});
 await expectSaved(page,s=>s.adWallet.length===1);expect((await snapshot(page)).adWallet[0].amount).toBe(123.45);expect((await snapshot(page)).transactions).toHaveLength(0);
});

test('concurrent wallet changes reject stale topups and deletion confirmations',async({page})=>{
 await boot(page,seed());await nav(page,'ads');const form=await topup(page);
 await page.evaluate(date=>{window.__testDB.adWallet=[{id:'remote',amount:200,date,note:'remote'}];window.__testSubscribers.adWallet(structuredClone(window.__testDB.adWallet));},today());
 await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('ยอดเติมเงินเปลี่ยนแปลง');await page.locator('#modal-ok-btn').click();
 expect((await snapshot(page)).adWallet).toHaveLength(1);
 await nav(page,'home');await nav(page,'ads');await page.locator('.ad-wallet-details > summary').click();await page.locator('[data-ad-remove-topup]').click();
 await page.evaluate(()=>{window.__testDB.adWallet[0].amount=300;window.__testSubscribers.adWallet(structuredClone(window.__testDB.adWallet));});
 await page.locator('#modal-ok-btn').click();await expect(page.locator('#modal-message')).toContainText('ยอดเติมเงินเปลี่ยนแปลง');expect((await snapshot(page)).adWallet[0].amount).toBe(300);
});

test('invalid topup amounts, future dates and daily budgets cannot mutate data',async({page})=>{
 await boot(page,seed());await nav(page,'ads');const form=await topup(page);
 await form.evaluate(f=>f.noValidate=true);
 for(const amount of ['-1','0','1.234']) {await form.locator('[name="amount"]').fill(amount);await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('ยอดเติมเงินต้อง');await page.locator('#modal-ok-btn').click();}
 await form.locator('[name="amount"]').fill('10');await form.locator('[name="date"]').fill('2099-01-01');await form.locator('button').click();await expect(page.locator('#modal-message')).toContainText('วันที่เติมเงิน');await page.locator('#modal-ok-btn').click();
 await page.locator('.ad-edit-details > summary').click();const edit=page.locator('.ad-edit-form');await edit.evaluate(f=>f.noValidate=true);await edit.locator('[name="dailyBudget"]').fill('-10');await edit.locator('button').click();await expect(page.locator('#modal-message')).toContainText('กรุณาตรวจ');
 expect((await snapshot(page)).adWallet).toHaveLength(0);expect((await snapshot(page)).adCampaigns[0].dailyBudget).toBe(100);
});

test('wallet backup and CSV round trip; malformed wallet and funding flags are rejected; legacy imports reset wallet',async({page})=>{
 const s=seed();s.adWallet=[{id:'topup-1',amount:200,date:today(),note:'=bad'}];
 s.transactions=[{id:'spend-1',adCampaignId:'ad-1',adWalletFunded:true,type:'expense',category:'ค่าโฆษณาสินค้า',date:today(),amount:50,desc:'ใช้จริง'}];
 await boot(page,s);await nav(page,'ads');expect(await download(page,'#ad-wallet-export')).toContain("'=bad");
 await page.locator('.data-tools summary').click();const backup=JSON.parse(await download(page,'#export-btn'));expect(backup.adWallet).toEqual(s.adWallet);expect(backup.version).toBe(10);
 const upload=data=>page.locator('#import-input').setInputFiles({name:'wallet.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 await upload(backup);await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.adWallet?.length===1);
 for(const mutate of [b=>b.adWallet[0].amount=-1,b=>b.adWallet.push({...b.adWallet[0]}),b=>b.adCampaigns[0].dailyBudget=0,b=>b.transactions[0].adWalletFunded='yes']) {
   const bad=structuredClone(backup);mutate(bad);await upload(bad);await expect(page.locator('#modal-message')).toContainText('ไม่ถูกต้อง');await page.locator('#modal-ok-btn').click();expect((await snapshot(page)).adWallet).toEqual(s.adWallet);
 }
 await upload(inventory());await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.adWallet.length===0);
});

for(const width of [390,1440]) test(`wallet and daily budget forms fit ${width}px and show shortages`,async({page})=>{
 await page.setViewportSize({width,height:900});const s=seed();s.adWallet=[{id:'topup',amount:10,date:today(),note:'บันทึก'}];
 const errors=await boot(page,s);await nav(page,'ads');await spend(page,'20');await expectSaved(page,s=>s.transactions.length===1);await expect(page.locator('.ad-wallet .ad-warning')).toContainText('เกินยอดเติมเงิน');
 await page.locator('.ad-wallet-details > summary').click();await page.locator('#ad-topup-form [name="amount"]').fill('50');await page.locator('#ad-topup-form button').click();await expectSaved(page,s=>s.adWallet.length===2);await expect(page.locator('[data-wallet-balance]')).toHaveText('฿40');
 await page.locator('.ad-wallet-details > summary').click();await page.locator('[data-ad-remove-topup="topup"]').click();await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.adWallet.length===1);await expect(page.locator('[data-wallet-balance]')).toHaveText('฿30');
 await page.locator('.ad-wallet-details > summary').click();await page.locator('.ad-edit-details > summary').click();await page.screenshot({path:`test-results/ads-wallet-${width}.png`,fullPage:true});
 const d=await page.evaluate(()=>({w:document.documentElement.clientWidth,s:document.documentElement.scrollWidth}));expect(d.s).toBeLessThanOrEqual(d.w+1);expect(errors).toEqual([]);
});
