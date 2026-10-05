const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, today } = require('./helpers');

test('profit menu reconciles margins, expenses and per-unit profit without deducting costs twice', async ({ page }) => {
  const state = inventory();
  state.transactions = [
    { id: 'sale', type: 'income', category: 'ขายสินค้า', date: today(), desc: 'เสื้อดำ ×2', qty: 2, amount: 500, unitCost: 100, profit: 240, shipping: 40, commission: 20, personalUsePercent: 20 },
    { id: 'loss', type: 'installment', category: 'ขายสินค้า', date: today(), desc: 'ขายขาดทุน', qty: 1, amount: 50, profit: -50, paidAmount: 0 },
    { id: 'cancel', type: 'income', category: 'ขายสินค้า', date: today(), qty: 1, amount: 900, profit: 900, deliveryStatus: 'cancelled' },
    { id: 'deleted', type: 'income', category: 'ขายสินค้า', date: today(), qty: 1, amount: 900, profit: 900, ledgerDeletedAt: today() },
    { id: 'shipping', type: 'expense', category: 'ค่าส่ง', date: today(), productId: 'variant-1', amount: 40 },
    { id: 'stock', type: 'expense', category: 'ซื้อสินค้าเข้าสต็อก', date: today(), productId: 'variant-1', amount: 1000 },
    { id: 'rent', type: 'expense', category: 'ค่าเช่า', date: today(), amount: 30 }
  ];
  const errors = await boot(page, state);
  await nav(page, 'profit');
  await expect(page.locator('#profit-table tbody tr')).toHaveCount(2);
  const cells = page.locator('#profit-table tbody tr').first().locator('td');
  await expect(cells).toHaveText([today(), 'เสื้อดำ ×2', '2', '฿500', '฿200', '฿300', '฿40', '฿20', '฿100', '฿140', '฿70']);
  const stat = label => page.locator('#profit-results .stat').filter({ has: page.locator('.lbl', { hasText: new RegExp('^' + label + '$') }) }).locator('.val');
  await expect(stat('กำไรก่อนค่าใช้จ่าย')).toHaveText('฿250');
  await expect(stat('กำไรหลังค่าใช้จ่ายรายรายการ')).toHaveText('฿90');
  await expect(stat('กำไรคงเหลือหลังค่าใช้จ่ายที่บันทึก')).toHaveText('฿60');
  await page.locator('#profit-from').fill('2099-01-01');
  await expect(page.locator('#profit-results')).toContainText('ยังไม่มีรายการขาย');
  await page.locator('#profit-to').fill('2000-01-01');
  await expect(page.locator('#profit-error')).toHaveText('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด');
  await expect(page.locator('#profit-results')).toBeEmpty();
  await page.locator('#profit-clear').click();
  await expect(page.locator('#profit-table tbody tr')).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({ path: 'test-results/profit-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('profit breakdown includes fulfilled preorders and dated overhead even without sales', async ({ page }) => {
  const state = inventory();
  state.transactions = [
    { id: 'po', type: 'preorder', category: 'ขายสินค้า', date: '2026-01-10', desc: 'พรีส่งมอบ', qty: 1, amount: 300, profit: 180, shipping: 20, commission: 0 },
    { id: 'ad', type: 'expense', category: 'ค่าโฆษณาสินค้า', adCampaignId: 'historical-ad', date: '2026-01-10', amount: 20 },
    { id: 'rent', type: 'expense', category: 'ค่าเช่า', date: '2026-02-10', amount: 100 }
  ];
  await boot(page, state); await nav(page, 'profit');
  await expect(page.locator('#profit-table tbody tr')).toHaveCount(1);
  await expect(page.locator('#profit-table tbody tr td').nth(4)).toHaveText('฿100');
  await expect(page.locator('#profit-results .stat').filter({ has: page.locator('.lbl', { hasText: /^ค่าแอด$/ }) }).locator('.val')).toHaveText('฿20');
  await expect(page.locator('#profit-results .stat').filter({ has: page.locator('.lbl', { hasText: /^กำไรคงเหลือหลังค่าใช้จ่ายที่บันทึก$/ }) }).locator('.val')).toHaveText('฿60');
  await page.locator('#profit-from').fill('2026-02-01');
  await expect(page.locator('#profit-results')).toContainText('฿-100');
  await nav(page, 'home'); await nav(page, 'profit');
  await expect(page.locator('#profit-from')).toHaveValue('2026-02-01');
});
