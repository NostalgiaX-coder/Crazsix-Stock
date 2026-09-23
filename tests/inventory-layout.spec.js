const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, today, snapshot, expectSaved } = require('./helpers');

function mixedStock() {
  const seed = inventory();
  seed.products[0].variants = [
    { ...seed.products[0].variants[0], id: 'available-variant', qty: 5 },
    { ...seed.products[0].variants[0], id: 'soldout-new', size: 'L', qty: 0 }
  ];
  seed.products.push({
    id: 'soldout-product', name: 'เสื้อหมดสต็อกเท่านั้น', createdAt: today(), variants: [
      { id: 'soldout-used', color: 'ขาว', size: 'XL', type: 'used', cost: 80, price: 200, qty: 0, createdAt: today() },
      { id: 'legacy-negative', color: 'แดง', size: 'S', type: 'new', cost: 100, price: 250, qty: -1, createdAt: today() }
    ]
  });
  return seed;
}

test('stock separates zero and negative quantities below available variants and keeps their actions', async ({ page }) => {
  const errors = await boot(page, mixedStock());
  await nav(page, 'stock');
  const available = page.locator('[data-stock-section="available"]');
  const soldout = page.locator('[data-stock-section="soldout"]');
  await expect(available).toBeVisible();
  await expect(soldout).toBeVisible();
  await expect(available.locator('[data-edit]')).toHaveCount(1);
  await expect(available.locator('[data-edit="available-variant"]')).toBeVisible();
  await expect(soldout.locator('[data-edit]')).toHaveCount(3);
  for (const id of ['soldout-new', 'soldout-used', 'legacy-negative']) {
    await expect(soldout.locator(`[data-edit="${id}"]`)).toBeVisible();
    await expect(soldout.locator(`[data-del="${id}"]`)).toBeVisible();
  }
  expect(await available.evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('[data-stock-section="soldout"]')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

  // The two variants from the same name/color group must split between sections.
  await expect(available).toContainText('เสื้อ Crazsix');
  await expect(soldout).toContainText('เสื้อ Crazsix');
  await page.locator('#stock-search').fill('เสื้อหมดสต็อกเท่านั้น');
  await expect(available).toBeHidden();
  await expect(soldout).toBeVisible();
  await expect(soldout.locator('[data-edit]:visible')).toHaveCount(2);
  await page.locator('#stock-search').fill('ไม่มีรายการนี้');
  await expect(available).toBeHidden();
  await expect(soldout).toBeHidden();
  await page.locator('#stock-search').clear();
  await expect(available).toBeVisible();
  await expect(soldout).toBeVisible();

  await soldout.locator('[data-edit="soldout-new"]').click();
  await expect(page.locator('#edit-overlay')).toHaveClass(/show/);
  await expect(page.locator('#edit-form [name="qty"]')).toHaveValue('0');
  await page.locator('#edit-cancel-btn').click();
  await soldout.locator('[data-del="soldout-new"]').click();
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => !db.products[0].variants.some(variant => variant.id === 'soldout-new'));
  expect((await snapshot(page)).products[0].variants[0]).toMatchObject({ id: 'available-variant', qty: 5 });
  expect(errors).toEqual([]);
});

function shippingStock() {
  const seed = inventory();
  seed.products[0].name = 'เสื้อยืด Crazsix รุ่น Limited Edition สีดำ';
  return seed;
}

test('desktop shipping rows keep readable product names after filtering and save selected quantities', async ({ page }) => {
  const errors = await boot(page, shippingStock());
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="shipping"]').click();
  const row = page.locator('[data-attach-row]').filter({ has: page.locator('option[value="variant-1"]') });
  const label = row.locator('.variant-info');
  await expect(label).toContainText('เสื้อยืด Crazsix รุ่น Limited Edition สีดำ');
  let box = await label.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(180);
  expect(box.height).toBeLessThanOrEqual(120);
  expect(await row.evaluate(element => getComputedStyle(element).display)).toBe('grid');

  await page.locator('#attach-ship-search').fill('ไม่พบสินค้านี้');
  await expect(row).toBeHidden();
  await expect(row).toHaveJSProperty('hidden', true);
  await page.locator('#attach-ship-search').clear();
  await expect(row).toBeVisible();
  expect(await row.evaluate(element => getComputedStyle(element).display)).toBe('grid');
  box = await label.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(180);
  await row.locator('.attach-size-select').selectOption('variant-1');
  await row.locator('.attach-qty').fill('3');
  await page.locator('#attach-ship-amount').fill('65');
  await page.locator('#attach-ship-submit').click();
  await expectSaved(page, db => db.transactions.length === 1);
  expect((await snapshot(page)).transactions[0]).toMatchObject({ amount: 65, type: 'expense', items: [{ productId: 'variant-1', qty: 3 }] });
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(10);
  expect(errors).toEqual([]);
});

test('mobile shipping controls remain visible and within the viewport after searching', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, shippingStock());
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="shipping"]').click();
  await page.locator('#attach-ship-search').fill('Crazsix');
  const row = page.locator('[data-attach-row]').first();
  for (const selector of ['.variant-info', '.attach-size-select', '.attach-qty']) {
    const control = row.locator(selector);
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
  }
  const labelBox = await row.locator('.variant-info').boundingBox();
  expect(labelBox.width).toBeGreaterThanOrEqual(180);
  expect(labelBox.height).toBeLessThanOrEqual(150);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.locator('#attach-ship-search').clear();
  expect(await row.evaluate(element => getComputedStyle(element).display)).toBe('grid');
});
