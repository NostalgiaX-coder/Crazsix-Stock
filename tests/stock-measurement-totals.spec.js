const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');

test('new stock without measurements joins the known size before sections and filters', async ({ page }) => {
  const state = inventory();
  const base = state.products[0].variants[0];
  state.products[0].variants = [
    { ...base, id: 'plain', qty: 3, cost: 100 },
    { ...base, id: 'measured', qty: 0, cost: 200, chestInches: 22, lengthInches: 28 },
    { ...base, id: 'used', type: 'used', qty: 1 }
  ];
  const errors = await boot(page, state);
  await nav(page, 'stock');
  const row = page.locator('[data-stock-variant="measured"]');
  await expect(row).toContainText('คงเหลือ 3 ชิ้น');
  await expect(row).toContainText('อก 22 นิ้ว');
  await expect(page.locator('[data-stock-variant="plain"]')).toHaveCount(0);
  await expect(page.locator('[data-stock-section="available"]')).toContainText('คงเหลือ 3 ชิ้น');
  await expect(row.locator('[data-edit="measured"]')).toBeVisible();
  await page.locator('#stock-search').fill('อก 22');
  await expect(page.locator('#stock-visible-totals')).toContainText('3 ชิ้น');
  const download = page.waitForEvent('download');
  await page.locator('#stock-export-filtered').click();
  const stream = await (await download).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString();
  expect(csv).not.toContain('plain');
  expect(csv).toContain('measured');
  expect(csv).not.toContain('used');
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(row.locator('[data-edit="measured"]')).toBeVisible();
  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(widths[0]).toBeLessThanOrEqual(widths[1] + 1);
  await page.locator('#stock-status').selectOption('low');
  await expect(row).toBeHidden();
  expect(await snapshot(page)).toEqual(state);
  expect(errors).toEqual([]);
});

test('combined stock preserves value and leaves ambiguous or partially measured sizes separate', async ({ page }) => {
  const state = inventory();
  const base = state.products[0].variants[0];
  state.products[0].variants = [
    { ...base, id: 'measured', qty: 2, cost: 200, chestInches: 22, lengthInches: 28 },
    { ...base, id: 'plain', qty: 3, cost: 100 },
    { ...base, id: 'partial', qty: 1, chestInches: 22 },
    { ...base, id: 'large-one', size: 'L', qty: 1, chestInches: 24, lengthInches: 29 },
    { ...base, id: 'large-two', size: 'L', qty: 1, chestInches: 25, lengthInches: 29 },
    { ...base, id: 'large-plain', size: 'L', qty: 4 }
  ];
  await boot(page, state);
  await nav(page, 'stock');
  const row = page.locator('[data-stock-variant="measured"]');
  await expect(row).toContainText('คงเหลือ 5 ชิ้น');
  await expect(row).toContainText('140');
  await expect(page.locator('[data-stock-variant="partial"]')).toBeVisible();
  await expect(page.locator('[data-stock-variant="large-plain"]')).toBeVisible();
  await page.locator('#stock-search').fill('อก 22');
  await expect(page.locator('#stock-visible-totals')).toContainText('6 ชิ้น');
  await expect(page.locator('#stock-visible-totals')).toContainText('800');
});

function combinedSeed() {
  const s = inventory();
  const base = s.products[0].variants[0];
  s.products[0].variants = [
    { ...base, id: 'measured', qty: 2, cost: 200, chestInches: 22, lengthInches: 28 },
    { ...base, id: 'plain', qty: 3, cost: 100 }
  ];
  s.preorders = [{ id: 'old-order', name: 'เสื้อ Crazsix', customer: 'ลูกค้าเดิม', status: 'delivered', type: 'new', qty: 1, unitPrice: 250, paidAmount: 250, refundedAmount: 0, createdAt: today(), fulfillment: { variantId: 'plain' } }];
  s.transactions = [
    { id: 'purchase', type: 'expense', category: 'ซื้อสินค้าเข้าสต็อก', date: today(), amount: 300, productId: 'plain', items: [{ productId: 'plain', qty: 3 }] },
    { id: 'lot', type: 'expense', category: 'ค่าส่งสินค้าเข้า', date: today(), amount: 30, receivingLot: { items: [{ kind: 'stock', id: 'old-pending', variantId: 'plain', qty: 3, weight: 0, share: 30, label: 'เข้าสต็อก · เสื้อ Crazsix · ดำ M', purchase: { cost: 100, productId: 'product-1' } }] } }
  ];
  return s;
}

test('every menu uses one stock option and selling persists stock and historical references atomically', async ({ page }) => {
  const s = combinedSeed();
  const errors = await boot(page, s);
  await expect(page.locator('.variant-row')).toHaveCount(1);
  await expect(page.locator('.variant-row')).toContainText('5');
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="count"]').click();
  await expect(page.locator('#stocktake-form [name="variantId"] option[value]')).toHaveCount(2);
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('[name="mode"][value="restock"]').locator('..').click();
  await expect(page.locator('.restock-variant option[value="measured"]')).toContainText('5');
  await expect(page.locator('.restock-variant option[value="plain"]')).toHaveCount(0);
  await nav(page, 'sell');
  const card = page.locator('[data-sale-card]').first();
  await expect(card.locator('.sell-size-select option')).toHaveCount(1);
  await card.locator('.sell-qty').fill('4');
  await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.transactions.some(t => t.category === 'ขายสินค้า'));
  const db = await snapshot(page);
  expect(db.products[0].variants).toHaveLength(1);
  expect(db.products[0].variants[0]).toMatchObject({ id: 'measured', qty: 1, cost: 140, stockAliases: ['plain'] });
  expect(db.transactions.find(t => t.id === 'purchase')).toMatchObject({ amount: 300, productId: 'measured', items: [{ productId: 'measured', qty: 3 }] });
  expect(db.transactions.find(t => t.id === 'lot').receivingLot.items[0]).toMatchObject({ variantId: 'measured', purchase: { cost: 100, productId: 'product-1' } });
  expect(db.preorders[0].fulfillment.variantId).toBe('measured');
  expect(db.transactions.find(t => t.category === 'ขายสินค้า')).toMatchObject({ productId: 'measured', qty: 4, unitCost: 140, chestInches: 22, lengthInches: 28 });
  await page.addInitScript(saved => { window.__testDB = saved; }, db);
  await page.reload();
  await nav(page, 'home');
  await expect(page.locator('.variant-row')).toHaveCount(1);
  await nav(page, 'sell');
  await expect(page.locator('.sell-size-select')).toContainText('เหลือ 1');
  expect(errors).toEqual([]);
});

test('failed saves and stale device updates preserve the combined stock without double counting', async ({ page }) => {
  const s = combinedSeed();
  await boot(page, s);
  await nav(page, 'sell');
  const card = page.locator('[data-sale-card]').first();
  await card.locator('.sell-qty').fill('4');
  await page.evaluate(() => window.__testSaveError = 'offline');
  await card.locator('.sell-submit').click();
  await expect(page.locator('#modal-message')).toContainText('บันทึกไม่สำเร็จ');
  expect(await snapshot(page)).toEqual(s);
  await page.locator('#modal-ok-btn').click();
  await page.evaluate(() => delete window.__testSaveError);
  await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.products[0].variants.length === 1);
  await page.evaluate(() => {
    const tx = structuredClone(window.__testDB.transactions);
    tx.find(t => t.id === 'purchase').productId = 'plain';
    window.__testDB.transactions = tx;
    window.__testSubscribers.transactions(structuredClone(tx));
  });
  await nav(page, 'home');
  await expect(page.locator('.variant-row')).toHaveCount(1);
  await nav(page, 'sell');
  await page.locator('.sell-submit').first().click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 0);
  const db = await snapshot(page);
  expect(db.transactions.find(t => t.id === 'purchase').productId).toBe('measured');
  expect(db.transactions.filter(t => t.category === 'ขายสินค้า')).toHaveLength(2);
});

test('restocking an unmeasured option updates the common balance and selling screen', async ({ page }) => {
  const s = combinedSeed();
  await boot(page, s);
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('[name="mode"][value="restock"]').locator('..').click();
  await page.locator('.add-restock-option').click();
  await page.locator('#restock-rows > .restock-row').first().locator('.remove-restock-row').click();
  const row = page.locator('[data-new-option="true"]');
  await row.locator('.restock-color').fill(' ดำ ');
  await row.locator('.restock-size').fill('m');
  await row.locator('.restock-qty').fill('2');
  await row.locator('.restock-row-cost').fill('100');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 7);
  const db = await snapshot(page);
  expect(db.products[0].variants).toHaveLength(1);
  expect(db.products[0].variants[0].cost).toBeCloseTo(900 / 7);
  await nav(page, 'sell');
  await expect(page.locator('.sell-size-select option')).toHaveCount(1);
  await expect(page.locator('.sell-size-select')).toContainText('เหลือ 7');
});

test('cancel an old sale from the unmeasured ID and return units to the combined balance', async ({ page }) => {
  const s = combinedSeed();
  s.preorders = [];
  s.transactions = [{ id: 'old-sale', type: 'income', category: 'ขายสินค้า', date: today(), desc: 'เสื้อ Crazsix ดำ M', productId: 'plain', qty: 1, unitCost: 100, amount: 250, profit: 150, deliveryStatus: 'pending' }];
  const errors = await boot(page, s);
  await nav(page, 'shipments');
  await page.locator('[data-cancel-sale="old-sale"]').click();
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => db.transactions[0].deliveryStatus === 'cancelled');
  const db = await snapshot(page);
  expect(db.products[0].variants).toHaveLength(1);
  expect(db.products[0].variants[0]).toMatchObject({ id: 'measured', qty: 6 });
  expect(db.products[0].variants[0].cost).toBeCloseTo(800 / 6);
  expect(db.transactions[0]).toMatchObject({ productId: 'measured', amount: 250, unitCost: 100 });
  expect(errors).toEqual([]);
});

test('unmeasured supplier receipt goes into the same known option with its own purchase history', async ({ page }) => {
  const s = combinedSeed();
  s.preorders = [];
  s.transactions = [{ id: 'pending-purchase', type: 'expense', category: 'สั่งซื้อสินค้า (รอของมาส่ง)', amount: 200, date: today(), pendingIds: ['incoming'] }];
  s.pendingOrders = [{ id: 'incoming', productId: 'product-1', name: 'เสื้อ Crazsix', color: 'ดำ', size: 'M', type: 'new', cost: 100, price: 250, qty: 2, orderDate: today() }];
  await boot(page, s);
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="pending"]').click();
  await page.locator('#pending-select-all').click();
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.length === 0);
  const db = await snapshot(page);
  expect(db.products[0].variants).toHaveLength(1);
  expect(db.products[0].variants[0]).toMatchObject({ id: 'measured', qty: 7 });
  expect(db.products[0].variants[0].cost).toBeCloseTo(900 / 7);
  const item = db.transactions.find(t => t.receivingLot).receivingLot.items[0];
  expect(item).toMatchObject({ variantId: 'measured', qty: 2, purchase: { cost: 100 } });
  expect(item.purchase.chestInches).toBeUndefined();
});

test('combined stock IDs survive backup import and cannot collide with another active option', async ({ page }) => {
  const s = combinedSeed();
  s.preorders = [];
  s.transactions = [];
  const errors = await boot(page, s);
  await nav(page, 'sell');
  await page.locator('.sell-submit').first().click();
  await expectSaved(page, db => db.products[0].variants.length === 1);
  await nav(page, 'stock');
  await page.locator('.data-tools summary').click();
  const downloading = page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const stream = await (await downloading).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString());
  expect(backup.products[0].variants[0].stockAliases).toEqual(['plain']);
  const upload = data => page.locator('#import-input').setInputFiles({ name: 'stock.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  const writes = await page.evaluate(() => window.__testWrites.length);
  await upload(backup);
  await page.locator('#modal-ok-btn').click();
  await expect.poll(() => page.evaluate(() => window.__testWrites.length)).toBe(writes + 1);
  const saved = await snapshot(page);
  expect(saved.products[0].variants[0]).toMatchObject({ id: 'measured', qty: 4, cost: 140, stockAliases: ['plain'] });
  const bad = structuredClone(backup);
  bad.products[0].variants.push({ ...bad.products[0].variants[0], id: 'plain', type: 'used', stockAliases: [] });
  await upload(bad);
  await expect(page.locator('#modal-message')).toContainText('รหัสรายการซ้ำ');
  expect(await snapshot(page)).toEqual(saved);
  expect(errors).toEqual([]);
});
