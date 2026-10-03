const {test,expect}=require('@playwright/test');
const {boot,nav,inventory,snapshot,expectSaved,today}=require('./helpers');
const ago=n=>new Date(Date.parse(today())-n*86400000).toISOString().slice(0,10);
function seed(){return {...inventory(),adCampaigns:[{id:'a',name:'แคมเปญปิดแล้ว',productId:'product-1',channel:'fb',status:'paused',autoDeduct:false,startDate:ago(3),endDate:'',runMode:'until_budget',dailyBudget:100,targetQty:1,reservePercent:0,note:'',url:'',autoHistory:[{date:ago(3),startDate:ago(3),endDate:'',runMode:'until_budget',status:'active',dailyBudget:100,enabled:true,productIds:['product-1']},{date:today(),startDate:ago(3),endDate:'',runMode:'until_budget',status:'paused',dailyBudget:100,enabled:false,productIds:['product-1']}]}],adWallet:[{id:'w',date:ago(3),amount:300,note:''}]};}
async function ready(page){await boot(page,seed());await expectSaved(page,s=>s.transactions.length===3);await nav(page,'tx');}
test('delete automatic ad expense refunds credit and never recreates it on reconciliation or backup restore',async({page})=>{
 await ready(page);const id='ad-auto-a-'+ago(1);
 await page.locator(`[data-txdel="${id}"]`).click();await expect(page.locator('#modal-message')).toContainText('คืนยอดนี้');await page.locator('#modal-ok-btn').click();
 await expectSaved(page,s=>s.transactions.length===2);
 await nav(page,'ads');await expect(page.locator('[data-wallet-balance]')).toHaveText('฿100');
 const result=await page.evaluate(async date=>{const {reconcileAutomaticAds,validateAdsBackup,adWalletMetrics}=await import('/js/ads.js');const s=JSON.parse(JSON.stringify(window.__testDB));const n=reconcileAutomaticAds(s,date);return {count:n.transactions.length,credit:adWalletMetrics(n.adWallet,n.transactions).balance,valid:validateAdsBackup(n.adCampaigns,n.transactions,s.products)};},today());
 expect(result).toEqual({count:2,credit:100,valid:true});
});
test('editing an automatic cost refunds the difference; repeated edits and deletion keep the refund exact',async({page})=>{
 await ready(page);const id='ad-auto-a-'+ago(2);
 for(const amount of [40,60]){
  await page.locator(`[data-txedit="${id}"]`).click();await expect(page.locator('#add-tx-form [name="date"]')).toBeDisabled();
  await page.locator('#add-tx-form [name="amount"]').fill(String(amount));await page.locator('#add-tx-form [name="desc"]').fill('แก้ยอดจริง');await page.locator('#add-tx-form button[type="submit"]').click();
  await expectSaved(page,s=>s.transactions.find(t=>t.id===id)?.amount===amount);
 }
 const db=await snapshot(page);expect(db.transactions.find(t=>t.id===id).adAutomatic).toBeUndefined();
 await nav(page,'ads');await expect(page.locator('[data-wallet-balance]')).toHaveText('฿40');await nav(page,'tx');
 await page.locator(`[data-txdel="${id}"]`).click();await page.locator('#modal-ok-btn').click();await expectSaved(page,s=>s.transactions.length===2);
 await nav(page,'ads');await expect(page.locator('[data-wallet-balance]')).toHaveText('฿100');
});
test('refunds are available from correction date without retroactively spending them on another campaign',async({page})=>{
 await boot(page,inventory());const result=await page.evaluate(async()=>{
  const {reconcileAutomaticAds,applyAdAction,adWalletMetrics,validateAdsBackup}=await import('/js/ads.js');
  const c={id:'a',name:'A',productId:'product-1',channel:'fb',status:'active',startDate:'2026-01-01',endDate:'',runMode:'until_budget',dailyBudget:100,targetQty:1,reservePercent:0,note:'',url:''};
  let s={products:window.__testDB.products,adCampaigns:[c,{...c,id:'b'}],adWallet:[{id:'w',date:'2026-01-01',amount:100,note:''}],transactions:[]};s={...s,...reconcileAutomaticAds(s,'2026-01-04')};const tx=s.transactions[0];
  s={...s,...applyAdAction(s,{type:'removeSpend',campaignId:'a',expected:JSON.stringify(s.adCampaigns[0]),transactionId:tx.id,expectedTransaction:JSON.stringify(tx)},'x','2026-01-04')};
  const now=adWalletMetrics(s.adWallet,s.transactions).balance, later=reconcileAutomaticAds(s,'2026-01-05');
  return {now,dates:later.transactions.map(t=>t.date),valid:validateAdsBackup(s.adCampaigns,s.transactions,s.products)};
 });expect(result).toEqual({now:100,dates:['2026-01-04'],valid:true});
});
test('failed deletion is atomic and stale edit cannot overwrite a changed expense',async({page})=>{
 await ready(page);const id='ad-auto-a-'+ago(1);await page.evaluate(()=>window.__testSaveError='offline');
 await page.locator(`[data-txdel="${id}"]`).click();await page.locator('#modal-ok-btn').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');
 expect((await snapshot(page)).transactions).toHaveLength(3);expect((await snapshot(page)).adCampaigns[0].autoExcludedDates).toBeUndefined();await page.locator('#modal-ok-btn').click();
 await page.evaluate(()=>delete window.__testSaveError);await page.locator(`[data-txedit="${id}"]`).click();await page.locator('#add-tx-form [name="amount"]').fill('25');
 await page.evaluate(id=>{window.__testDB.transactions.find(t=>t.id===id).desc='changed elsewhere';},id);
 await page.locator('#add-tx-form button[type="submit"]').click();await expect(page.locator('#modal-message')).toBeVisible();expect((await snapshot(page)).transactions.find(t=>t.id===id).amount).toBe(100);
});
test('direct expenses never refund credit and correction history survives campaign edits with valid backups',async({page})=>{
 await boot(page,inventory());const result=await page.evaluate(async()=>{
  const {applyAdAction,reconcileAutomaticAds,adWalletMetrics,validateAdsBackup}=await import('/js/ads.js');
  const c={id:'a',name:'A',productId:'product-1',productIds:['product-1','p2'],channel:'fb',status:'paused',startDate:'2026-01-01',endDate:'',runMode:'until_budget',dailyBudget:100,targetQty:1,reservePercent:0,note:'',url:''};
  let s={products:[...window.__testDB.products,{...window.__testDB.products[0],id:'p2'}],adCampaigns:[c],adWallet:[{id:'w',date:'2026-01-01',amount:500,note:''}],transactions:[{id:'manual',type:'expense',category:'ค่าโฆษณาสินค้า',adCampaignId:'a',adWalletFunded:false,date:'2026-01-01',amount:100,desc:'direct',adAllocations:[{productId:'product-1',amount:75},{productId:'p2',amount:25}]}]};
  const act=(type,extra={})=>{s={...s,...applyAdAction(s,{type,campaignId:'a',expected:JSON.stringify(s.adCampaigns[0]),transactionId:s.transactions[0]?.id,expectedTransaction:JSON.stringify(s.transactions[0]),...extra},'x','2026-01-03')};};
  act('editSpend',{amount:80,desc:'corrected'});const shares=s.transactions[0].adAllocations;
  act('removeSpend');act('edit',{values:{...s.adCampaigns[0],name:'Renamed'}});
  s={...s,...reconcileAutomaticAds(JSON.parse(JSON.stringify(s)),'2026-01-05')};
  const valid=validateAdsBackup(s.adCampaigns,s.transactions,s.products);
  s.adCampaigns[0].autoExcludedDates=['bad'];const invalid=validateAdsBackup(s.adCampaigns,s.transactions,s.products);
  return {shares,credit:adWalletMetrics(s.adWallet,s.transactions).balance,count:s.transactions.length,valid,invalid};
 });expect(result).toEqual({shares:[{productId:'p2',amount:20},{productId:'product-1',amount:60}],credit:500,count:0,valid:true,invalid:false});
});
