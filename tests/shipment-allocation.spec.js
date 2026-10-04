const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, today, snapshot, expectSaved } = require('./helpers');
function seed() {
  const s = inventory(); s.shipments = [];
  s.adCampaigns = [{ id: 'ad', name: 'แอด', productId: 'product-1', channel: 'Facebook', status: 'active', startDate: today(), endDate: today(), targetQty: 10, reservePercent: 20, reservePerUnit: 30, note: '', url: '' }];
  return s;
}
async function send(page) { await page.locator('#shipment-submit').click(); await page.locator('#modal-ok-btn').click(); }
test('checkout saves percent of gross sales and each partial shipment announces only its own amounts', async ({ page }) => {
  const errors = await boot(page, seed()); await nav(page, 'sell');
  const card = page.locator('.sell-card').first();
  await card.locator('.sell-qty').fill('2');
  await card.locator('.sell-shipping').fill('40');
  await card.locator('.sell-commission').fill('20');
  await card.locator('.sell-ad-campaign').selectOption('ad');
  await card.locator('.sell-ad-reserve').fill('35');
  await card.locator('.sell-personal-percent').fill('20');
  await expect(card.locator('.sell-personal-preview')).toContainText('฿100');
  await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.transactions.some(tx => tx.personalUsePercent === 20));
  const before = await snapshot(page);
  await nav(page, 'shipments'); await page.locator('.shipment-select').check();
  await page.locator('.shipment-qty').fill('1'); await page.locator('#shipment-cost').fill('10'); await send(page);
  await expectSaved(page, db => db.shipments.length === 1);
  await expect(page.locator('#shipment-allocation-notice [data-allocation-ads]')).toHaveText('฿35');
  await expect(page.locator('#shipment-allocation-notice [data-allocation-personal]')).toHaveText('฿50');
  await page.locator('.shipment-select').check(); await send(page);
  await expectSaved(page, db => db.shipments.length === 2);
  await expect(page.locator('#shipment-allocation-notice [data-allocation-personal]')).toHaveText('฿50');
  const after = await snapshot(page);
  expect(after.shipments.map(s => s.allocation.personalAmount)).toEqual([50, 50]);
  expect(after.products).toEqual(before.products);
  await nav(page, 'home'); await nav(page, 'shipments');
  await expect(page.locator('.shipment-history [data-allocation-personal]')).toHaveText(['฿50', '฿50']);
  expect(errors).toEqual([]);
});
test('mixed sale rates combine per parcel, installments remain plans, and old sales default to zero', async ({ page }) => {
  const s = seed();
  s.transactions = [
    { id: 'a', type: 'income', category: 'ขายสินค้า', desc: 'ดำ M', date: today(), amount: 750, profit: 450, qty: 3, productId: 'variant-1', deliveryStatus: 'pending', adCampaignId: 'ad', adReservePerUnit: 30, personalUsePercent: 10 },
    { id: 'b', type: 'installment', category: 'ขายสินค้า', desc: 'ขาว L', date: today(), amount: 200, profit: 120, paidAmount: 0, qty: 1, productId: 'variant-2', deliveryStatus: 'pending', personalUsePercent: 25 }
  ];
  const errors = await boot(page, s); await nav(page, 'shipments');
  await page.locator('#shipment-select-all').check(); await page.locator('#send-qty-a').fill('2'); await send(page);
  await expectSaved(page, db => db.shipments.length === 1);
  const summary = page.locator('#shipment-allocation-notice');
  await expect(summary.locator('[data-allocation-ads]')).toHaveText('฿60');
  await expect(summary.locator('[data-allocation-personal]')).toHaveText('฿100');
  await expect(summary).toContainText('ยังรับเงินไม่ครบ');
  const db = await snapshot(page);
  expect(db.shipments[0].allocation.revenue).toBe(700);
  expect(db.transactions.map(tx => tx.amount)).toEqual([750, 200]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#shipment-allocation-notice').screenshot({ path: 'test-results/shipment-allocation-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  expect(errors).toEqual([]);
});
test('invalid percentages cannot sell, and zero and 100 percent are supported', async ({ page }) => {
  await boot(page, seed()); await nav(page, 'sell'); const card = page.locator('.sell-card').first();
  for (const value of ['-1', '101', '20.123']) {
    await card.locator('.sell-personal-percent').fill(value); await card.locator('.sell-submit').click();
    await expect(page.locator('#modal-message')).toContainText('เปอร์เซ็นต์เงินใช้ส่วนตัว');
    await page.locator('#modal-ok-btn').click();
    expect((await snapshot(page)).transactions).toHaveLength(0);
  }
  await card.locator('.sell-personal-percent').fill('100'); await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.transactions.some(tx => tx.personalUsePercent === 100));
  await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.transactions.some(tx => tx.personalUsePercent === 0));
});
test('partial shipment rounding, legacy ad percentages and allocation backup validation', async ({ page }) => {
  await boot(page, seed());
  const result = await page.evaluate(async () => {
    const { applyShipmentAction, validateShipments } = await import('/js/shipments.js');
    const state = structuredClone(window.__testDB); const date = state.adCampaigns[0].startDate;
    delete state.adCampaigns[0].reservePerUnit;
    state.transactions = [{ id: 'sale', type: 'income', category: 'ขายสินค้า', date, amount: 1, profit: 1, qty: 3, deliveryStatus: 'pending', personalUsePercent: 50, adCampaignId: 'ad' }];
    const portions = [];
    for (let i = 0; i < 3; i++) {
      const next = applyShipmentAction(state, { type: 'ship', expectedShipments: JSON.stringify(state.shipments), expectedSales: { sale: JSON.stringify(state.transactions[0]) }, values: { date, recipient: '', carrier: '', trackingNumber: '', note: '', items: [{ saleId: 'sale', qty: 1 }] } }, `parcel-${i}`, date);
      Object.assign(state, next); portions.push(next.shipments[0].allocation.personalAmount);
    }
    const valid = validateShipments(state.shipments, state.transactions);
    const ad = state.shipments[0].allocation.adReserve;
    state.shipments[0].allocation.personalAmount = 999;
    const invalidSum = validateShipments(state.shipments, state.transactions);
    state.shipments[0].allocation.items = [null];
    const invalidItem = validateShipments(state.shipments, state.transactions);
    return { portions, valid, invalidSum, invalidItem, ad };
  });
  expect(result).toEqual({ portions: [0.17, 0.16, 0.17], valid: true, invalidSum: false, invalidItem: false, ad: 0.07 });
});
