const { test, expect } = require('@playwright/test');
const { boot, nav, radio, inventory, snapshot, expectSaved } = require('./helpers');
async function mode(page, value) {
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await radio(page, `[name="mode"][value="${value}"]`);
}

test('restock adds a new color and size to the selected product and preserves existing row inputs', async ({ page }) => {
  const errors = await boot(page);
  await mode(page, 'restock');
  const original = page.locator('.restock-row:not(.restock-heading)').first();
  await original.locator('.restock-variant').selectOption('variant-1');
  await original.locator('.restock-row-cost').fill('150');
  await original.locator('.restock-row-price').fill('300');
  await original.locator('.add-restock-option').click();
  await expect(original.locator('.restock-row-cost')).toHaveValue('150');
  const added = page.locator('[data-new-option="true"]');
  await expect(added.locator('.restock-product')).toHaveValue('product-1');
  await added.locator('.restock-color').fill('น้ำเงิน');
  await added.locator('.restock-size').fill('XL');
  await added.locator('.restock-qty').fill('2');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products[0].variants.length === 3);
  const db = await snapshot(page);
  expect(db.products).toHaveLength(1);
  expect(db.products[0].variants.find(v => v.color === 'น้ำเงิน')).toMatchObject({ size: 'XL', qty: 2, cost: 150, price: 300 });
  expect(db.products[0].variants.find(v => v.id === 'variant-1').qty).toBe(11);
  expect(db.transactions.reduce((sum, tx) => sum + tx.amount, 0)).toBe(450);
  expect(errors).toEqual([]);
});

test('new option rows merge a matching existing option and support a lump total', async ({ page }) => {
  await boot(page);
  await mode(page, 'restock');
  await page.locator('.add-restock-option').click();
  await page.locator('#restock-rows > .restock-row').first().locator('.remove-restock-row').click();
  const added = page.locator('[data-new-option="true"]');
  await added.locator('.restock-color').fill(' ดำ ');
  await added.locator('.restock-size').fill('m');
  await added.locator('.restock-qty').fill('2');
  await radio(page, '[name="restockCostMode"][value="lump"]');
  await page.locator('[name="restockLumpCost"]').fill('300');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products[0].variants.find(v => v.id === 'variant-1').qty === 12);
  const db = await snapshot(page);
  expect(db.products[0].variants).toHaveLength(2);
  expect(db.products[0].variants[0].cost).toBeCloseTo(1300 / 12);
  expect(db.transactions[0].amount).toBe(300);
});

test('restock rejects duplicate options across existing and new rows before writing', async ({ page }) => {
  const state = inventory();
  await boot(page, state);
  await mode(page, 'restock');
  await page.locator('.add-restock-option').click();
  await page.locator('.restock-size').last().fill('M');
  await page.locator('#add-product-submit').click();
  await expect(page.locator('#modal-overlay')).toContainText('สภาพซ้ำ');
  expect(await snapshot(page)).toEqual(state);
});

test('supplier ordering adds multiple options without creating stock before receiving and survives renaming', async ({ page }) => {
  const state = inventory();
  const errors = await boot(page, state);
  await mode(page, 'pending');
  await page.locator('.pRowProduct').selectOption('product-1');
  await expect(page.locator('.pRowName')).toHaveValue('เสื้อ Crazsix');
  await page.locator('.pRowColor').fill('แดง');
  await page.locator('.pRowSize').fill('M');
  await page.locator('.pRowQty').fill('2');
  await page.locator('.pRowCost').fill('120');
  await page.locator('.pRowPrice').fill('280');
  await page.locator('.add-pending-option').click();
  await expect(page.locator('.pRowProduct').last()).toHaveValue('product-1');
  await page.locator('.pRowSize').last().fill('L');
  await page.locator('.pRowQty').last().fill('3');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.pendingOrders.length === 2);
  expect((await snapshot(page)).products).toEqual(state.products);
  expect((await snapshot(page)).transactions[0].amount).toBe(600);
  await page.evaluate(() => {
    window.__testDB.products[0].name = 'เสื้อชื่อใหม่';
    window.__testSubscribers.products(structuredClone(window.__testDB.products));
  });
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="pending"]').click();
  await page.locator('#pending-select-all').click();
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.length === 0);
  const db = await snapshot(page);
  expect(db.products).toHaveLength(1);
  expect(db.products[0].name).toBe('เสื้อชื่อใหม่');
  expect(db.products[0].variants.filter(v => v.color === 'แดง').map(v => v.qty).sort()).toEqual([2, 3]);
  expect(db.transactions).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('failed new-option restock preserves all rows and retry creates the option once', async ({ page }) => {
  await boot(page);
  await mode(page, 'restock');
  await page.locator('.add-restock-option').click();
  await page.locator('.restock-size').last().fill('XL');
  await page.evaluate(() => { window.__testSaveError = 'Offline'; });
  await page.locator('#add-product-submit').click();
  await expect(page.locator('#modal-overlay')).toContainText('บันทึกไม่สำเร็จ');
  expect((await snapshot(page)).products[0].variants).toHaveLength(2);
  await page.locator('#modal-ok-btn').click();
  await expect(page.locator('.restock-size').last()).toHaveValue('XL');
  await page.evaluate(() => { window.__testSaveError = null; });
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products[0].variants.length === 3);
});

for (const width of [390, 1440]) {
  test(`new color and size forms fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await boot(page);
    await mode(page, 'restock');
    await page.locator('.add-restock-option').click();
    await page.locator('.restock-size').last().fill('XL');
    await page.screenshot({ path: `test-results/restock-options-${width}.png`, fullPage: true });
    let size = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(size[0]).toBeLessThanOrEqual(size[1] + 1);
    await radio(page, '[name="mode"][value="pending"]');
    await page.locator('.pRowProduct').selectOption('product-1');
    await page.locator('.add-pending-option').click();
    await expect(page.locator('.pending-row')).toHaveCount(2);
    await page.screenshot({ path: `test-results/pending-options-${width}.png`, fullPage: true });
    size = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(size[0]).toBeLessThanOrEqual(size[1] + 1);
    expect(errors).toEqual([]);
  });
}
