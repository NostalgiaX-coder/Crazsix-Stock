const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, today } = require('./helpers');

test('dark is the default; keyboard toggle preserves form input and persists across reloads and navigation', async ({page})=>{
 const errors=await boot(page);await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed','true');
 await nav(page,'ads');await page.locator('#ad-create-form [name="name"]').fill('แคมเปญที่กำลังกรอก');
 await page.locator('#theme-toggle').focus();await page.keyboard.press('Enter');
 await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await expect(page.locator('#ad-create-form [name="name"]')).toHaveValue('แคมเปญที่กำลังกรอก');
 await expect(page.locator('#theme-toggle')).toHaveAccessibleName('เปลี่ยนเป็นโหมดมืด');
 await nav(page,'stock');await expect(page.locator('#theme-toggle .theme-toggle-label')).toHaveText('โหมดสว่าง');
 await page.reload();await expect(page.locator('#theme-toggle')).toBeVisible();await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.locator('#theme-toggle').click();await page.reload();await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed','true');
 expect(await page.evaluate(()=>window.__testWrites.length)).toBe(0);expect(errors).toEqual([]);
});

test('theme still works when browser storage is unavailable',async({page})=>{
 await page.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('storage blocked');};Storage.prototype.setItem=()=>{throw new Error('storage blocked');};});
 const errors=await boot(page);await page.locator('#theme-toggle').click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await nav(page,'sell');await page.locator('#theme-toggle').click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');expect(errors).toEqual([]);
});

test('report charts update colors in place and cross-tab theme changes preserve dates',async({page})=>{
 const seed=inventory();seed.transactions=[{id:'sale',type:'income',category:'ขายสินค้า',date:today(),amount:250,profit:150,qty:1,productId:'variant-1'}];
 const errors=await boot(page,seed);await nav(page,'report');await page.locator('#report-from').fill('2026-01-01');
 const read=()=>page.evaluate(()=>{const c=Chart.getChart(document.getElementById('trend-chart'));return {id:c.id,color:c.data.datasets[2].borderColor,tick:c.options.scales.y.ticks.color};});
 const dark=await read();expect(dark.color).toBe('#a2afe8');
 await page.locator('#theme-toggle').click();const light=await read();expect(light.id).toBe(dark.id);expect(light.color).toBe('#16214a');expect(light.tick).not.toBe(dark.tick);
 await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'crazsix-theme',newValue:'dark'})));
 await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed','true');await expect(page.locator('#report-from')).toHaveValue('2026-01-01');expect((await read()).color).toBe('#a2afe8');expect(errors).toEqual([]);
});

for(const width of [390,1440]) test(`dark surfaces, dialogs and readable text at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:width===390?844:1000});const errors=await boot(page);
 await page.screenshot({path:`test-results/dark-home-${width}.png`,fullPage:true});
 await expect(page.locator('body')).toHaveCSS('background-color','rgb(18, 23, 31)');
 await nav(page,'ads');await expect(page.locator('#ad-create-form [name="name"]')).toHaveCSS('background-color','rgb(21, 28, 38)');
 await page.screenshot({path:`test-results/dark-ads-${width}.png`,fullPage:true});
 await nav(page,'stock');await page.locator('[data-edit="variant-1"]').click();await expect(page.locator('#edit-overlay .modal-box')).toHaveCSS('background-color','rgb(32, 41, 54)');
 await page.screenshot({path:`test-results/dark-dialog-${width}.png`,fullPage:true});await page.keyboard.press('Escape');
 const size=await page.evaluate(()=>({w:document.documentElement.clientWidth,s:document.documentElement.scrollWidth}));expect(size.s).toBeLessThanOrEqual(size.w+1);
 // Common text and form labels must maintain at least 4.5:1 contrast.
 const contrasts=await page.evaluate(()=>{
  const lum=rgb=>{const c=rgb.match(/[\d.]+/g).slice(0,3).map(n=>{const v=Number(n)/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return c[0]*.2126+c[1]*.7152+c[2]*.0722;};
  return ['.field label','.hint','th'].map(selector=>{const el=document.querySelector(selector);const fg=lum(getComputedStyle(el).color),bg=lum('rgb(27, 34, 45)');return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);});
 });contrasts.forEach(r=>expect(r).toBeGreaterThanOrEqual(4.5));expect(errors).toEqual([]);
});
