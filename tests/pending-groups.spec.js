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
  expect(db.transactions.find(tx => tx.id === 'purchase').amount).toBe(610);
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
test('conditions remain distinct while measured and unmeasured sizes combine; grouped receipt survives failed writes', async ({ page }) => {
  const s = seed();
  s.pendingOrders.push({ ...s.pendingOrders[0], id: 'used', type: 'used' }, { ...s.pendingOrders[0], id: 'measured', chestInches: 22 });
  await boot(page, s); await open(page);
  await expect(page.locator('.pending-select')).toHaveCount(3);
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


test('F1 Jacket Black L combines 4 measured and 2 unmeasured pending units while right details stay separate', async ({ page }) => {
  const s = inventory();
  s.products[0].name = 'F1 Jacket';
  const base = { color: 'Black', size: 'L', type: 'new', price: 250, cost: 100 };
  s.products[0].variants = [
    { ...base, id: 'measured-stock', qty: 1, chestInches: 24, lengthInches: 28 },
    { ...base, id: 'plain-stock', qty: 0 }
  ];
  s.pendingOrders = [
    { ...base, id: 'measured-order', name: 'F1 Jacket', qty: 4, chestInches: 24, lengthInches: 28, orderDate: '2026-01-01' },
    { ...base, id: 'plain-order', name: 'F1 Jacket', qty: 2, orderDate: today() }
  ];
  const errors = await boot(page, s); await nav(page, 'stock');
  await expect(page.locator('[data-stock-variant="measured-stock"] .stock-size-pending')).toHaveText('รอรับ 6 ชิ้น');
  await expect(page.locator('[data-stock-variant="plain-stock"] .stock-size-pending')).toHaveText('รอรับ 6 ชิ้น');
  await expect(page.locator('.stock-pending-option')).toHaveCount(2);
  await expect(page.locator('.stock-pending-option').filter({ hasText: 'อก 24' })).toContainText('รอรับ 4 ชิ้น');
  await expect(page.locator('.stock-pending-option').filter({ hasNotText: 'อก 24' })).toContainText('รอรับ 2 ชิ้น');
  await page.locator('[data-workspace-tab="pending"]').click();
  await expect(page.locator('.pending-select')).toHaveCount(1);
  await expect(page.locator('.pending-receive-qty')).toHaveValue('6');
  await page.locator('.pending-select').check();
  await page.locator('.pending-receive-qty').fill('5');
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.length === 1 && db.pendingOrders[0].qty === 1);
  const db = await snapshot(page);
  expect(db.products[0].variants.find(v => v.id === 'measured-stock').qty).toBe(5);
  expect(db.products[0].variants.find(v => v.id === 'plain-stock').qty).toBe(1);
  expect(errors).toEqual([]);
});
