const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');
function seed(partial = false) {
  const state = inventory();
  state.pendingOrders = [{ id: 'pending-a', name: 'เสื้อ', color: 'ดำ', size: 'M', type: 'new', cost: 80, price: 200, qty: partial ? 1 : 3, orderDate: today(), ...(partial ? { originalQty: 3, receivedQty: 2 } : {}) }, { id: 'pending-b', name: 'เสื้อ', color: 'ขาว', size: 'L', type: 'new', cost: 50, price: 200, qty: 2, orderDate: today() }];
  state.transactions = [{ id: 'purchase', type: 'expense', category: 'สั่งซื้อสินค้า (รอของมาส่ง)', amount: 340, date: today(), pendingIds: ['pending-a', 'pending-b'] }, { id: 'shipping', type: 'expense', category: 'ค่าส่งสินค้าเข้า', amount: 20, date: today() }];
  return state;
}
async function cancel(page, id) {
  await page.locator(`[data-cancel-pending="${id}"]`).click();
  await page.locator('#modal-ok-btn').click();
}
for (const partial of [false, true]) test(`pending cancellation adjusts shared purchase and preserves received costs: partial=${partial}`, async ({ page }) => {
  const state = seed(partial);
  await boot(page, state); await nav(page, 'stock');
  await page.locator('[data-workspace-tab="pending"]').click();
  await cancel(page, 'pending-a');
  await expectSaved(page, db => db.pendingOrders.length === 1);
  let db = await snapshot(page);
  expect(db.products).toEqual(state.products);
  expect(db.transactions.find(tx => tx.id === 'purchase')).toMatchObject({ amount: partial ? 260 : 100, pendingIds: ['pending-b'] });
  await nav(page, 'tx');
  await expect(page.locator('tr').filter({ has: page.locator('[data-txdel="purchase"]') })).toContainText(partial ? '฿260' : '฿100');
  await nav(page, 'stock'); await page.locator('[data-workspace-tab="pending"]').click();
  await cancel(page, 'pending-b');
  await expectSaved(page, db => db.pendingOrders.length === 0);
  db = await snapshot(page);
  expect(db.transactions.reduce((s, tx) => s + tx.amount, 0)).toBe(partial ? 180 : 20);
  await nav(page, 'home'); await expect(page.locator('.expense-stat')).toContainText(partial ? '฿180' : '฿20');
  await nav(page, 'report'); await expect(page.locator('#report-range-summary .val').nth(1)).toHaveText(partial ? '฿180' : '฿20');
});
test('failed pending cancellation rolls back both order and expense and retry deducts once', async ({ page }) => {
  const state = seed(); await boot(page, state); await nav(page, 'stock');
  await page.locator('[data-workspace-tab="pending"]').click();
  await page.evaluate(() => window.__testSaveError = 'offline'); await cancel(page, 'pending-a');
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');
  expect((await snapshot(page)).transactions).toEqual(state.transactions);
  expect((await snapshot(page)).pendingOrders).toEqual(state.pendingOrders);
  await page.locator('#modal-ok-btn').click(); await page.evaluate(() => delete window.__testSaveError);
  await cancel(page, 'pending-a'); await expectSaved(page, db => db.pendingOrders.length === 1);
  expect((await snapshot(page)).transactions.find(tx => tx.id === 'purchase').amount).toBe(100);
});
test('pending cancellation requires fresh confirmation if the purchase changes', async ({ page }) => {
  await boot(page, seed()); await nav(page, 'stock');
  await page.locator('[data-workspace-tab="pending"]').click();
  await page.locator('[data-cancel-pending="pending-a"]').click();
  await page.evaluate(() => {
    window.__testDB.transactions[0].amount = 400;
    window.__testSubscribers.transactions(structuredClone(window.__testDB.transactions));
  });
  await page.locator('#modal-ok-btn').click();
  await expect(page.locator('#modal-message')).toContainText('เปลี่ยนแปลง');
  expect((await snapshot(page)).pendingOrders).toHaveLength(2);
  expect((await snapshot(page)).transactions[0].amount).toBe(400);
});

test('cancelling an entire pending purchase removes its ledger row and expense totals', async ({ page }) => {
  const state = seed();
  state.pendingOrders = [state.pendingOrders[0]];
  state.transactions = [{ ...state.transactions[0], amount: 240, pendingIds: ['pending-a'] }];
  await boot(page, state); await nav(page, 'tx');
  await expect(page.locator('tr').filter({ has: page.locator('[data-txdel="purchase"]') })).toContainText('฿240');
  await nav(page, 'stock'); await page.locator('[data-workspace-tab="pending"]').click();
  await cancel(page, 'pending-a');
  await expectSaved(page, db => db.pendingOrders.length === 0 && db.transactions.length === 0);
  await nav(page, 'tx'); await expect(page.locator('[data-txdel="purchase"]')).toHaveCount(0);
  await nav(page, 'home'); await expect(page.locator('.expense-stat')).toContainText('฿0');
  await nav(page, 'report'); await expect(page.locator('#report-range-summary .val').nth(1)).toHaveText('฿0');
  expect((await snapshot(page)).products).toEqual(state.products);
});
