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

test('available stock includes only sizes with positive quantities and keeps zero sizes in sold out', async ({ page }) => {
  const errors = await boot(page, mixedStock());
  await nav(page, 'stock');
  const available = page.locator('[data-stock-section="available"]');
  const soldout = page.locator('[data-stock-section="soldout"]');
  await expect(available).toBeVisible();
  await expect(soldout).toBeVisible();
  await expect(available.locator('[data-edit]')).toHaveCount(1);
  await expect(available.locator('[data-edit="available-variant"]')).toBeVisible();
  await expect(soldout.locator('[data-edit]')).toHaveCount(3);
  for (const id of ['soldout-used', 'legacy-negative']) {
    await expect(soldout.locator(`[data-edit="${id}"]`)).toBeVisible();
    await expect(soldout.locator(`[data-del="${id}"]`)).toBeVisible();
  }
  expect(await available.evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('[data-stock-section="soldout"]')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);

  // Zero quantities never appear under ready-to-sell stock.
  await expect(available).toContainText('เสื้อ Crazsix');
  await expect(soldout).toContainText('เสื้อ Crazsix');
  await expect(soldout.locator('[data-edit="soldout-new"]')).toBeVisible();
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

test('incoming stock counts only unreceived orders in the matching color and stock section', async ({ page }) => {
  const seed = mixedStock();
  const pending = { name: 'เสื้อ Crazsix', color: 'ดำ', size: 'M', type: 'new', cost: 100, price: 250, orderDate: today() };
  seed.pendingOrders = [
    { ...pending, id: 'incoming-m', qty: 3, originalQty: 8, receivedQty: 5 },
    { ...pending, id: 'incoming-l', size: 'L', qty: 4 },
    { ...pending, id: 'incoming-xl', size: 'XL', qty: 2 },
    { ...pending, id: 'incoming-other', name: 'สินค้าอื่น', qty: 90 },
    { ...pending, id: 'incoming-white', color: 'ขาว', qty: 80 },
    { ...pending, id: 'incoming-linked', name: 'ชื่อก่อนเปลี่ยน', productId: 'product-1', qty: 1 }
  ];
  const errors = await boot(page, seed);
  await nav(page, 'stock');
  const available = page.locator('[data-stock-section="available"]');
  const soldout = page.locator('[data-stock-section="soldout"]');
  await expect(available.locator('th').nth(5)).toHaveText('สั่งซื้อรอรับ');
  await expect(available.locator('[data-stock-pending]')).toHaveText('6');
  await expect(available.locator('[data-stock-variant="available-variant"] .stock-size-pending')).toHaveText('รอรับ 4 ชิ้น');
  await expect(available.locator('.stock-pending-option').filter({ hasText: 'ไซส์ M' })).toContainText('รอรับ 4 ชิ้น');
  await expect(available.locator('.stock-pending-option').filter({ hasText: 'ไซส์ XL' })).toContainText('รอรับ 2 ชิ้น');
  await expect(soldout.locator('[data-stock-variant="soldout-new"] .stock-size-pending')).toHaveText('รอรับ 4 ชิ้น');
  await expect(soldout.locator('[data-stock-variant="soldout-used"] .stock-size-pending')).toHaveText('รอรับ 0 ชิ้น');
  await expect(soldout.locator('tr').filter({ has: page.locator('[data-edit="soldout-used"]') }).locator('[data-stock-pending]')).toHaveText('0');
  await page.locator('[data-workspace-tab="pending"]').click();
  await page.locator('.pending-select[data-pending-id="incoming-m"]').check();
  await page.locator('.pending-receive-qty[data-pending-id="incoming-m"]').fill('2');
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.find(order => order.id === 'incoming-m').qty === 1);
  await page.locator('[data-workspace-tab="inventory"]').click();
  await expect(available.locator('[data-stock-pending]')).toHaveText('4');
  await expect(available.locator('[data-stock-variant="available-variant"] .stock-size-pending')).toHaveText('รอรับ 2 ชิ้น');
  await expect(available.locator('tbody tr td').nth(4)).toHaveText('7');
  expect(errors).toEqual([]);
});


test('new colors move to sold out only when every new size is empty, independently of used stock', async ({ page }) => {
  const seed = mixedStock();
  seed.products[0].variants[0].qty = 0;
  seed.pendingOrders = [{ id: 'new-size-incoming', name: seed.products[0].name, color: 'ดำ', size: 'XXL', type: 'new', qty: 6, cost: 100, price: 250, orderDate: today() }];
  seed.products[0].variants.push(
    { ...seed.products[0].variants[0], id: 'used-available', type: 'used', qty: 2 },
    { ...seed.products[0].variants[0], id: 'white-available', color: 'ขาว', qty: 3 },
    { ...seed.products[0].variants[1], id: 'white-empty', color: 'ขาว', qty: 0 },
    { ...seed.products[0].variants[1], id: 'white-used-empty', color: 'ขาว', type: 'used', qty: 0 }
  );
  const errors = await boot(page, seed);
  await nav(page, 'stock');
  const available = page.locator('[data-stock-section="available"]');
  const soldout = page.locator('[data-stock-section="soldout"]');
  await expect(soldout.locator('tr').filter({ has: page.locator('[data-edit="soldout-new"]') }).locator('[data-stock-pending]')).toHaveText('6');
  await expect(available.locator('tr').filter({ has: page.locator('[data-edit="used-available"]') }).locator('[data-stock-pending]')).toHaveText('0');
  for (const id of ['used-available', 'white-available']) {
    await expect(available.locator(`[data-edit="${id}"]`)).toBeVisible();
    await expect(soldout.locator(`[data-edit="${id}"]`)).toHaveCount(0);
  }
  for (const id of ['available-variant', 'soldout-new', 'white-used-empty', 'white-empty']) {
    await expect(soldout.locator(`[data-edit="${id}"]`)).toBeVisible();
    await expect(available.locator(`[data-edit="${id}"]`)).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});
