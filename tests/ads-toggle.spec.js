const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');
function seed() {
  return {...inventory(), adWallet:[{id:'fund',amount:1000,date:today(),note:''}], adCampaigns:[{id:'a',name:'แคมเปญ A',productId:'product-1',channel:'Facebook',status:'active',autoDeduct:true,startDate:today(),endDate:'',runMode:'until_budget',dailyBudget:100,targetQty:10,reservePercent:20,note:'',url:''}]};
}
test('campaign details start collapsed, expand for editing and retain state after toggle', async ({page}) => {
  await boot(page, seed()); await nav(page,'ads');
  const body=page.locator('.ad-card-body'), toggle=page.getByRole('switch');
  await expect(body).toBeHidden(); await expect(toggle).toHaveAttribute('aria-checked','true');
  await page.locator('[data-ad-expand]').click(); await expect(body).toBeVisible();
  await page.locator('.ad-edit-details > summary').click(); await expect(page.locator('.ad-edit-form')).toBeVisible();
  await toggle.click(); await expectSaved(page,s=>s.adCampaigns[0].status==='paused');
  await expect(toggle).toHaveAttribute('aria-checked','false'); await expect(body).toBeVisible();
  await toggle.click(); await expectSaved(page,s=>s.adCampaigns[0].status==='active');
  await expect(toggle).toHaveAttribute('aria-checked','true');
  await page.locator('[data-ad-expand]').click(); await expect(body).toBeHidden();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('failed toggle preserves saved state and can be retried',async({page})=>{
  await boot(page,seed());await nav(page,'ads');await page.evaluate(()=>window.__testSaveError='offline');
  await page.getByRole('switch').click();await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');
  expect((await snapshot(page)).adCampaigns[0].status).toBe('active');
  await page.locator('#modal-ok-btn').click();await expect(page.getByRole('switch')).toHaveAttribute('aria-checked','true');
  await page.evaluate(()=>delete window.__testSaveError);await page.getByRole('switch').click();
  await expectSaved(page,s=>s.adCampaigns[0].status==='paused');
});
test('toggle excludes OFF days, preserves history and affects only the selected campaign',async({page})=>{
  await boot(page,inventory());
  const result=await page.evaluate(async()=>{
    const {applyAdAction,reconcileAutomaticAds,validateAdsBackup}=await import('/js/ads.js');
    const c={id:'a',name:'A',productId:'product-1',channel:'fb',status:'active',startDate:'2026-01-01',endDate:'',runMode:'until_budget',dailyBudget:100,targetQty:1,reservePercent:0,note:'',url:''};
    let s={products:window.__testDB.products,adCampaigns:[c,{...c,id:'b'}],adWallet:[{id:'w',date:'2026-01-01',amount:3000,note:''}],transactions:[]};
    const toggle=(enabled,date)=>{s={...s,...applyAdAction(s,{type:'toggle',campaignId:'a',expected:JSON.stringify(s.adCampaigns[0]),enabled},'unused',date)};};
    toggle(false,'2026-01-03');toggle(true,'2026-01-06');s={...s,...reconcileAutomaticAds(s,'2026-01-08')};
    return {a:s.transactions.filter(t=>t.adCampaignId==='a').map(t=>t.date), b:s.transactions.filter(t=>t.adCampaignId==='b').length, valid:validateAdsBackup(s.adCampaigns,s.transactions,s.products)};
  });
  expect(result).toEqual({a:['2026-01-07','2026-01-06','2026-01-02','2026-01-01'],b:7,valid:true});
});
test('cannot turn on deductions without a daily budget',async({page})=>{
  const s=seed();s.adCampaigns[0].dailyBudget=null;s.adCampaigns[0].status='paused';
  await boot(page,s);await nav(page,'ads');await page.getByRole('switch').click();
  await expect(page.locator('#modal-message')).toContainText('ระบุงบยิงแอดต่อวัน');
  expect((await snapshot(page)).adCampaigns[0].status).toBe('paused');
});
