const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, today, snapshot, expectSaved } = require('./helpers');
function seed() {
  const s = inventory();
  const base = { name: 'เสื้อ Crazsix', color: 'ดำ', size: 'M', type: 'new', price: 250 };
  s.pendingOrders = [
    { ...base, id: 'recent', productId: 'product-1', cost: 120, qty: 3, orderDate: today(), note: 'ล็อตใหม่' },
    { ...base, id: 'older', cost: 80, qty: 2, orderDate: '2026-01-01', note: 'ล็อตเก่า' },
    { ...base, id: 'white', color: 'ขาว', cost: 90, qty: 1, orderDate: today() }
  ];
  s.transactions = [{ id: 'purchase', type: 'expense', category: 'สั่งซื้อสินค้า (รอของมาส่ง)', amount: 610, date: today(), pendingIds: ['recent', 'older', 'white'] }];
  return s;
}
async function open(page) { await nav(page, 'stock'); await page.locator('[data-workspace-tab="pending"]').click(); }
test('same option becomes one receipt row and receives oldest lots with their original costs', async ({ page }) => {
  const errors = await boot(page, seed()); await open(page);
  await expect(page.locator('.pending-select')).toHaveCount(2);
  const row = page.locator('.variant-row').filter({ has: page.locator('[data-cancel-pending="recent"]') });
  await expect(row).toContainText('x5');
  await expect(row.locator('.pending-receive-qty')).toHaveValue('5');
  await row.locator('.pending-select').check();
  await row.locator('.pending-receive-qty').fill('3');
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.length === 2 && db.pendingOrders[0].qty === 2);
  const db = await snapshot(page);
  expect(db.products[0].variants[0].qty).toBe(13);
  expect(db.products[0].variants[0].cost).toBeCloseTo((1000 + 160 + 120) / 13);
  expect(db.transactions[0].amount).toBe(610);
  expect(db.pendingOrders.find(order => order.id === 'older')).toBeUndefined();
  await expect(row).toContainText('x2');
  expect(errors).toEqual([]);
});
test('cancelling a combined row deducts all its unreceived lots once and preserves other colors', async ({ page }) => {
  await boot(page, seed()); await open(page);
  await page.locator('[data-cancel-pending="recent"]').click();
  await expect(page.locator('#modal-message')).toContainText('5 ชิ้น');
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => db.pendingOrders.length === 1);
  const db = await snapshot(page);
  expect(db.pendingOrders[0].id).toBe('white');
  expect(db.transactions[0]).toMatchObject({ amount: 90, pendingIds: ['white'] });
  expect(db.products).toEqual(seed().products);
});
test('different condition and measurements remain distinct; grouped receipt survives failed writes', async ({ page }) => {
  const s = seed();
  s.pendingOrders.push({ ...s.pendingOrders[0], id: 'used', type: 'used' }, { ...s.pendingOrders[0], id: 'measured', chestInches: 22 });
  await boot(page, s); await open(page);
  await expect(page.locator('.pending-select')).toHaveCount(4);
  await page.locator('.pending-select[data-pending-id="recent"]').check();
  await page.locator('.pending-receive-qty[data-pending-id="recent"]').fill('4');
  await page.evaluate(() => window.__testSaveError = 'offline');
  await page.locator('#pending-receive-selected').click();
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');
  expect((await snapshot(page)).pendingOrders).toEqual(s.pendingOrders);
  await page.locator('#modal-ok-btn').click(); await page.evaluate(() => delete window.__testSaveError);
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.find(o => o.id === 'recent').qty === 1);
});
