const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, radio, today } = require('./helpers');
async function countForm(page) {
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="count"]').click();
  const form = page.locator('#stocktake-form');
  await form.locator('[name="variantId"]').selectOption('variant-1');
  return form;
}

test('inventory filters operate per variant, show matching totals and export only matching stock', async ({ page }) => {
  const state = inventory();
  state.products[0].variants.push({ ...state.products[0].variants[0], id: 'empty', size: 'S', qty: 0 });
  await boot(page, state);
  await nav(page, 'stock');
  await page.locator('#stock-condition').selectOption('used');
  await expect(page.locator('[data-stock-variant]:visible')).toHaveCount(1);
  await expect(page.locator('#stock-visible-totals')).toContainText('1 ชิ้น · มูลค่า ฿80');
  await page.locator('#stock-status').selectOption('out');
  await expect(page.locator('[data-stock-variant]:visible')).toHaveCount(0);
  await page.locator('#stock-clear').click();
  await page.locator('#stock-search').fill('ไซส์ S');
  await expect(page.locator('[data-stock-variant]:visible')).toHaveCount(1);
  const pending = page.waitForEvent('download');
  await page.locator('#stock-export-filtered').click();
  const stream = await (await pending).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  expect(text).toContain('empty'); expect(text).not.toContain('variant-1');
  await page.locator('#stock-clear').click();
  await page.locator('#stock-sort').selectOption('qty');
  await expect(page.locator('[data-stock-section="available"] [data-stock-variant]').first()).toHaveAttribute('data-stock-variant', 'variant-2');
});

test('physical counts preserve costs and accounting and record before, after and reason in backups', async ({ page }) => {
  const state = inventory();
  const errors = await boot(page, state);
  const form = await countForm(page);
  await form.locator('[name="actual"]').fill('7');
  await form.locator('[name="reason"]').fill('ตรวจนับ พบสินค้าเสียหาย 3 ชิ้น');
  await expect(page.locator('#stocktake-preview')).toContainText('ผลต่าง -3');
  await form.locator('[type="submit"]').click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 7);
  const db = await snapshot(page);
  expect(db.products[0].variants[0]).toMatchObject({ qty: 7, cost: 100, price: 250, adjustments: [{ before: 10, after: 7, delta: -3, reason: 'ตรวจนับ พบสินค้าเสียหาย 3 ชิ้น' }] });
  expect(db.transactions).toEqual(state.transactions);
  await expect(page.locator('#workspace-count')).toContainText('ตรวจนับ พบสินค้าเสียหาย 3 ชิ้น');
  await page.locator('#import-input').setInputFiles({ name: 'count-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(db)) });
  await page.locator('#modal-ok-btn').click();
  await expect.poll(() => page.evaluate(() => window.__testWrites.length)).toBe(2);
  expect((await snapshot(page)).products[0].variants[0].adjustments).toEqual(db.products[0].variants[0].adjustments);
  expect(errors).toEqual([]);
});

test('failed count saves preserve input and retry creates exactly one adjustment', async ({ page }) => {
  const state = inventory();
  await boot(page, state);
  const form = await countForm(page);
  await form.locator('[name="actual"]').fill('8');
  await form.locator('[name="reason"]').fill('ตรวจนับ');
  await page.evaluate(() => { window.__testSaveError = 'Offline'; });
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('บันทึกไม่สำเร็จ');
  expect(await snapshot(page)).toEqual(state);
  await page.locator('#modal-ok-btn').click();
  await expect(form.locator('[name="actual"]')).toHaveValue('8');
  await page.evaluate(() => { window.__testSaveError = null; });
  await form.locator('[type="submit"]').click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 8);
  expect((await snapshot(page)).products[0].variants[0].adjustments).toHaveLength(1);
});

test('physical counts reject a changed stock balance before overwriting another sale', async ({ page }) => {
  await boot(page);
  const form = await countForm(page);
  await form.locator('[name="actual"]').fill('8');
  await form.locator('[name="reason"]').fill('ตรวจนับ');
  await page.evaluate(() => {
    window.__testDB.products[0].variants[0].qty = 9;
    window.__testSubscribers.products(structuredClone(window.__testDB.products));
  });
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('สต็อกเปลี่ยนระหว่างตรวจนับ');
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(9);
  expect(await page.evaluate(() => window.__testWrites.length)).toBe(0);
});

test('editing rejects duplicate variants and supports weighted costs with full precision', async ({ page }) => {
  const state = inventory();
  state.products[0].variants[0].cost = 100 / 3;
  const errors = await boot(page, state);
  await nav(page, 'stock');
  await page.locator('[data-edit="variant-1"]').click();
  const form = page.locator('#edit-form');
  await form.locator('[name="color"]').fill('ขาว');
  await form.locator('[name="size"]').fill('L');
  await form.locator('[name="type"][value="used"]').check({ force: true });
  await form.locator('[type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('ตัวเลือกสี/ไซส์/สภาพซ้ำ');
  await page.locator('#modal-ok-btn').click();
  await form.locator('[name="size"]').fill('XL');
  await form.locator('[name="qty"]').fill('8');
  await form.locator('[name="reason"]').fill('ตรวจนับใหม่');
  await form.locator('[type="submit"]').click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 8);
  const variant = (await snapshot(page)).products[0].variants[0];
  expect(variant.cost).toBe(100 / 3);
  expect(variant.adjustments[0]).toMatchObject({ before: 10, after: 8, delta: -2, reason: 'ตรวจนับใหม่' });
  expect(errors).toEqual([]);
});

test('fractional restock quantities are rejected even when native form validation is bypassed', async ({ page }) => {
  const state = inventory();
  await boot(page, state);
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await radio(page, '[name="mode"][value="restock"]');
  await page.locator('.restock-variant').selectOption('variant-1');
  await page.locator('.restock-qty').fill('1.5');
  await page.locator('.restock-row-cost').fill('100');
  await page.locator('#add-product-submit').evaluate(button => button.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await expect(page.locator('#modal-overlay')).toContainText('จำนวนให้ถูกต้อง');
  expect(await snapshot(page)).toEqual(state);
});

test('shipping attachment rejects fractional quantities and quantities exceeding current stock', async ({ page }) => {
  const state = inventory();
  await boot(page, state);
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="shipping"]').click();
  await page.locator('.attach-qty').first().fill('1.5');
  await page.locator('#attach-ship-amount').fill('30');
  await page.locator('#attach-ship-submit').click();
  await expect(page.locator('#modal-overlay')).toContainText('จำนวนสินค้า');
  await page.locator('#modal-ok-btn').click();
  await page.locator('.attach-qty').first().fill('999');
  await page.locator('#attach-ship-submit').click();
  await expect(page.locator('#modal-overlay')).toContainText('ไม่เกินสต็อก');
  expect(await snapshot(page)).toEqual(state);
});

test('stock deletion rejects a quantity changed while confirmation is open', async ({ page }) => {
  await boot(page);
  await nav(page, 'stock');
  await page.locator('[data-del="variant-1"]').click();
  await page.evaluate(() => {
    window.__testDB.products[0].variants[0].qty = 9;
    window.__testSubscribers.products(structuredClone(window.__testDB.products));
  });
  await page.locator('#modal-ok-btn').click();
  await expect(page.locator('#modal-overlay')).toContainText('สินค้าเปลี่ยนแปลงระหว่างยืนยัน');
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(9);
});

for (const width of [390, 1440]) {
  test(`all five inventory workspaces are usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await boot(page);
    await nav(page, 'stock');
    for (const workspace of ['inventory', 'add', 'pending', 'shipping', 'count']) {
      await page.locator(`[data-workspace-tab="${workspace}"]`).click();
      await expect(page.locator(`#workspace-${workspace}`)).toBeVisible();
      const size = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(size[0], workspace).toBeLessThanOrEqual(size[1] + 1);
      if (workspace === 'count' && width === 390) {
        const field = await page.locator('#stocktake-form [name="variantId"]').boundingBox();
        expect(field.width).toBeGreaterThan(260);
      }
      if (workspace === 'count' || workspace === 'inventory') await page.screenshot({ path: `test-results/stock-${workspace}-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}

test('lump costs allocate whole cents without rounding inventory average cost', async ({ page }) => {
  await boot(page, { products: [], transactions: [], pendingOrders: [], preorders: [] });
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('.pb-name').fill('เสื้อล็อต');
  await page.locator('.pbRowSize').fill('S');
  await page.locator('.pbRowQty').fill('1');
  for (const size of ['M', 'L']) {
    await page.locator('.add-pb-size-row').click();
    await page.locator('.pbRowSize').last().fill(size);
    await page.locator('.pbRowQty').last().fill('1');
  }
  await page.locator('.pb-price').fill('100');
  await radio(page, '.pb-cost-mode-toggle input[value="lump"]');
  await page.locator('.pb-cost-lump').fill('100');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products.length === 1 && db.transactions.length === 3);
  const db = await snapshot(page);
  expect(db.transactions.map(tx => tx.amount).sort()).toEqual([33.33, 33.33, 33.34]);
  expect(db.transactions.reduce((sum,tx) => sum + Math.round(tx.amount * 100), 0)).toBe(10000);
  expect(db.products[0].variants.every(v => v.cost === 100 / 3)).toBe(true);
});
