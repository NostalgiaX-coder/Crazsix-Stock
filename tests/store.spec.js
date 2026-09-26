const { test, expect } = require('@playwright/test');
const { boot, nav, radio, inventory, snapshot, expectSaved, today } = require('./helpers');

test('adds multiple sizes, records costs, and restocks at weighted average cost', async ({ page }) => {
  const errors = await boot(page, { products: [], transactions: [], pendingOrders: [] });
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('.pb-name').fill('เสื้อทดสอบ');
  await page.locator('.pbRowColor').fill('ดำ');
  await page.locator('.pbRowSize').fill('M');
  await page.locator('.pbRowQty').fill('2');
  await page.locator('.add-pb-size-row').click();
  await page.locator('.pbRowColor').nth(1).fill('ดำ');
  await page.locator('.pbRowSize').nth(1).fill('L');
  await page.locator('.pbRowQty').nth(1).fill('1');
  await page.locator('.pb-price').fill('300');
  await page.locator('.pb-cost-perunit').fill('100');
  await page.locator('[name="shippingIn"]').fill('30');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products.length === 1 && db.transactions.length === 3);
  const added = await snapshot(page);
  const medium = added.products[0].variants.find(variant => variant.size === 'M');
  expect(added.products[0].variants.map(variant => variant.qty).sort()).toEqual([1, 2]);
  expect(added.transactions.reduce((sum, tx) => sum + tx.amount, 0)).toBe(330);

  await radio(page, '[name="mode"][value="restock"]');
  await page.locator('.restock-variant').selectOption(medium.id);
  await page.locator('.restock-qty').fill('2');
  await page.locator('.restock-row-cost').fill('150');
  await page.locator('.restock-row-price').fill('350');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.products[0].variants.find(v => v.id === medium.id).qty === 4);
  const restocked = await snapshot(page);
  expect(restocked.products[0].variants.find(v => v.id === medium.id)).toMatchObject({ qty: 4, cost: 125, price: 350 });
  expect(restocked.transactions.find(tx => tx.category === 'เติมสต๊อกสินค้าเดิม').amount).toBe(300);
  expect(errors).toEqual([]);
});

test('pending orders expense is recorded once and receiving adds inventory plus shipping', async ({ page }) => {
  await boot(page, { products: [], transactions: [], pendingOrders: [] });
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await radio(page, '[name="mode"][value="pending"]');
  await page.locator('.pRowName').fill('เสื้อรอรับ');
  await page.locator('.pRowColor').fill('ครีม');
  await page.locator('.pRowSize').fill('XL');
  await page.locator('.pRowQty').fill('3');
  await page.locator('.pRowCost').fill('80');
  await page.locator('.pRowPrice').fill('200');
  await page.locator('[name="pendingNote"]').fill('ออเดอร์ทดสอบ');
  await page.locator('#add-product-submit').click();
  await expectSaved(page, db => db.pendingOrders.length === 1 && db.transactions.length === 1);
  expect((await snapshot(page)).products).toEqual([]);
  await page.locator('[data-workspace-tab="pending"]').click();
  await page.locator('#pending-select-all').click();
  await page.locator('#pending-bulk-ship').fill('40');
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.length === 0 && db.products.length === 1);
  const received = await snapshot(page);
  expect(received.products[0].variants[0]).toMatchObject({ qty: 3, cost: 80 });
  expect(received.transactions.map(tx => tx.amount).sort((a, b) => a - b)).toEqual([40, 240]);
});

test('cash sale preserves stock, revenue, shipping, commission and profit calculations', async ({ page }) => {
  await boot(page);
  await nav(page, 'sell');
  const card = page.locator('[data-sale-card]').first();
  await card.locator('.sell-color-select').selectOption('ดำ');
  await card.locator('.sell-size-select').selectOption('variant-1');
  await card.locator('.sell-qty').fill('2');
  await card.locator('.sell-price-input').fill('250');
  await card.locator('.sell-shipping').fill('30');
  await card.locator('.sell-commission').fill('20');
  await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.transactions.length === 3);
  const sold = await snapshot(page);
  expect(sold.products[0].variants[0].qty).toBe(8);
  expect(sold.transactions.find(tx => tx.type === 'income')).toMatchObject({ amount: 500, qty: 2, unitCost: 100, profit: 250 });
  expect(sold.transactions.filter(tx => tx.type === 'expense').reduce((sum, tx) => sum + tx.amount, 0)).toBe(50);
});

test('installment deposits and subsequent payments reconcile without double-counting revenue', async ({ page }) => {
  await boot(page);
  await nav(page, 'sell');
  const card = page.locator('[data-sale-card]').first();
  await card.locator('.sell-installment').check();
  await card.locator('.sell-deposit').fill('50');
  await card.locator('.sell-customer').fill('ลูกค้าทดสอบ');
  await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.transactions.some(tx => tx.type === 'installment'));
  let db = await snapshot(page);
  const sale = db.transactions.find(tx => tx.type === 'installment');
  expect(sale).toMatchObject({ amount: 250, paidAmount: 50 });
  expect(db.transactions.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + tx.amount, 0)).toBe(50);
  await nav(page, 'installment');
  await page.locator(`[data-pay="${sale.id}"]`).click();
  await expect(page.locator('#payment-amount')).toHaveValue('200.00');
  await page.locator('#payment-submit-btn').click();
  await expectSaved(page, data => data.transactions.find(tx => tx.id === sale.id).paidAmount === 250);
  db = await snapshot(page);
  expect(db.transactions.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + tx.amount, 0)).toBe(250);
  await expect(page.locator(`[data-pay="${sale.id}"]`)).toHaveCount(0);
});

test('invalid sale quantity cannot mutate inventory or accounting', async ({ page }) => {
  await boot(page);
  await nav(page, 'sell');
  const card = page.locator('[data-sale-card]').first();
  await card.locator('.sell-qty').fill('99');
  await card.locator('.sell-submit').click();
  await expect(page.locator('#modal-overlay')).toHaveClass(/show/);
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(10);
  expect((await snapshot(page)).transactions).toEqual([]);
  await page.locator('#modal-ok-btn').click();
});

test('a rejected atomic sale restores inventory and leaves accounting unchanged', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__testSaveError = 'Simulated storage failure'; });
  await nav(page, 'sell');
  await page.locator('.sell-submit').first().click();
  await expect(page.locator('#modal-overlay')).toHaveClass(/show/);
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(10);
  expect((await snapshot(page)).transactions).toEqual([]);
  await page.locator('#modal-ok-btn').click();
  await page.evaluate(() => { window.__testSaveError = null; });
  await nav(page, 'sell');
  await page.locator('.sell-submit').first().click();
  await expectSaved(page, db => db.transactions.length === 1);
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(9);
});

test('rapid repeated sale clicks result in only one committed sale', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__testSaveDelay = 300; });
  await nav(page, 'sell');
  await page.locator('.sell-submit').first().dblclick();
  await expectSaved(page, db => db.transactions.length === 1);
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(9);
  expect(await page.evaluate(() => window.__testWrites.length)).toBe(1);
});

test('deleting an installment payment also restores its outstanding balance', async ({ page }) => {
  const seed = inventory();
  seed.transactions = [
    { id: 'payment-1', type: 'income', category: 'รับชำระค่าผ่อน', amount: 100, date: today(), installmentId: 'sale-1', productId: 'variant-1' },
    { id: 'sale-1', type: 'installment', category: 'ขายสินค้า', amount: 250, paidAmount: 100, date: today(), dueDate: today(), productId: 'variant-1', qty: 1, profit: 150 }
  ];
  await boot(page, seed);
  await nav(page, 'tx');
  await page.locator('[data-txdel="payment-1"]').click();
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => db.transactions.length === 1);
  expect((await snapshot(page)).transactions[0]).toMatchObject({ id: 'sale-1', paidAmount: 0 });
});

test('realtime snapshots do not erase an in-progress inventory form', async ({ page }) => {
  await boot(page);
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="add"]').click();
  await page.locator('.pb-name').fill('รายการที่ยังกรอกไม่เสร็จ');
  await page.locator('.pbRowQty').fill('4');
  await page.evaluate(() => {
    const changed = structuredClone(window.__testDB.products);
    changed[0].variants[0].qty = 7;
    window.__testSubscribers.products(changed);
  });
  await page.locator('.pb-price').focus();
  await expect(page.locator('.pb-name')).toHaveValue('รายการที่ยังกรอกไม่เสร็จ');
  await expect(page.locator('.pbRowQty')).toHaveValue('4');
});

test('dates and reports use Bangkok local calendar at a UTC month boundary', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-30T17:30:00.000Z'));
  const seed = inventory();
  seed.transactions = [{ id: 'month-fixture', type: 'income', category: 'รายรับอื่นๆ', amount: 100, date: '2026-10-01' }];
  await boot(page, seed);
  await nav(page, 'tx');
  await expect(page.locator('#add-tx-form [name="date"]')).toHaveValue('2026-10-01');
  await nav(page, 'report');
  await expect.poll(() => page.evaluate(() => window.Chart?.getChart(document.querySelector('#trend-chart'))?.data.labels.at(-1))).toBe('ต.ค. 2569');
});

test('local insights work with empty and populated stores without external AI requests', async ({ page }) => {
  const errors = await boot(page, { products: [], transactions: [], pendingOrders: [] });
  const requests = [];
  page.on('request', request => { if (request.resourceType() === 'fetch') requests.push(request.url()); });
  await nav(page, 'ai');
  await page.locator('#ai-run-btn').click();
  await expect(page.locator('#ai-result .insight-card')).toHaveCount(6);
  await page.evaluate(seed => {
    window.__testSubscribers.products(seed.products);
    window.__testSubscribers.transactions([{ id: 'sale', type: 'income', category: 'ขายสินค้า', desc: 'เสื้อ Crazsix', productId: 'variant-1', qty: 2, amount: 500, profit: 300, date: new Intl.DateTimeFormat('sv-SE').format(new Date()) }]);
  }, inventory());
  await nav(page, 'home');
  await nav(page, 'ai');
  await page.locator('#ai-run-btn').click();
  await expect(page.locator('#ai-result .insight-card')).toHaveCount(6);
  await expect(page.locator('#ai-result .table-wrap')).toBeVisible();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('search and condition filters keep inventory and sale choices reachable', async ({ page }) => {
  await boot(page);
  await page.locator('[data-home-filter="used"]').click();
  await expect(page.locator('#tab-content')).toContainText('ขาว');
  await page.locator('#home-search').fill('ไม่พบสินค้านี้');
  await expect(page.locator('.inventory-count')).toContainText('0 กลุ่มสินค้า');
  await page.locator('#home-search').fill('เสื้อ');
  await expect(page.locator('.inventory-count')).toContainText('1 กลุ่มสินค้า');
  await nav(page, 'stock');
  await page.locator('#stock-search').fill('ดำ');
  await expect(page.locator('#stock-filter-count')).toHaveText('1 กลุ่มสินค้า');
  await page.locator('#stock-search').fill('ไม่พบสินค้านี้');
  await expect(page.locator('#stock-filter-count')).toHaveText('0 กลุ่มสินค้า');
  await nav(page, 'sell');
  await page.locator('#sell-search').fill('ไม่พบสินค้านี้');
  await expect(page.locator('[data-sale-card]:visible')).toHaveCount(0);
  await page.locator('#sell-search').fill('เสื้อ');
  await expect(page.locator('[data-sale-card]:visible')).toHaveCount(1);
});

test('edit dialog supports keyboard dismissal, focus return, and saving variant changes', async ({ page }) => {
  const errors = await boot(page);
  await nav(page, 'stock');
  const trigger = page.locator('[data-edit="variant-1"]');
  await trigger.click();
  await expect(page.locator('#edit-overlay')).toHaveClass(/show/);
  await expect(page.locator('#edit-cancel-btn')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#edit-overlay')).not.toHaveClass(/show/);
  await expect(trigger).toBeFocused();
  await trigger.click();
  const form = page.locator('#edit-form');
  await form.locator('[name="name"]').fill('เสื้อแก้ไข');
  await form.locator('[name="qty"]').fill('7');
  await form.locator('[name="price"]').fill('290');
  await form.locator('[type="submit"]').click();
  await expectSaved(page, db => db.products[0].name === 'เสื้อแก้ไข' && db.products[0].variants[0].qty === 7);
  expect((await snapshot(page)).products[0].variants[0].price).toBe(290);
  await expect(page.locator('#edit-overlay')).not.toHaveClass(/show/);
  expect(errors).toEqual([]);
});

test('new and used variants with the same size remain distinct during checkout', async ({ page }) => {
  const seed = inventory();
  seed.products[0].variants[1] = { ...seed.products[0].variants[1], color: 'ดำ', size: 'M' };
  await boot(page, seed);
  await nav(page, 'sell');
  const card = page.locator('[data-sale-card]').first();
  await expect(card.locator('.sell-size-select option[value="variant-1"]')).toContainText('มือ1');
  await expect(card.locator('.sell-size-select option[value="variant-2"]')).toContainText('มือ2');
  await card.locator('.sell-size-select').selectOption('variant-2');
  await expect(card.locator('.sell-price-input')).toHaveValue('200');
  await card.locator('.sell-submit').click();
  await expectSaved(page, db => db.transactions.length === 1);
  expect((await snapshot(page)).products[0].variants.map(v => v.qty)).toEqual([10, 0]);
  expect((await snapshot(page)).transactions[0]).toMatchObject({ productId: 'variant-2', unitCost: 80, amount: 200 });
});

test('transaction text, type, and month filters combine and reset', async ({ page }) => {
  const seed = inventory();
  seed.transactions = [
    { id: 'rent', type: 'expense', category: 'ค่าเช่า', desc: 'ค่าเช่าร้าน', amount: 1000, date: '2026-09-01' },
    { id: 'sale', type: 'income', category: 'ขายสินค้า', desc: 'เสื้อ Crazsix', amount: 250, date: '2026-09-02' },
    { id: 'old-rent', type: 'expense', category: 'ค่าเช่า', desc: 'ค่าเช่าเดือนก่อน', amount: 900, date: '2026-08-01' }
  ];
  await boot(page, seed);
  await nav(page, 'tx');
  await page.locator('#tx-search').fill('ค่าเช่า');
  await expect(page.locator('[data-txdel]:visible')).toHaveCount(2);
  await page.locator('#tx-month-filter').fill('2026-09');
  await expect(page.locator('[data-txdel]:visible')).toHaveCount(1);
  await page.locator('#tx-type-filter').selectOption('income');
  await expect(page.locator('[data-txdel]:visible')).toHaveCount(0);
  await page.locator('#tx-clear-filters').click();
  await expect(page.locator('[data-txdel]:visible')).toHaveCount(3);
});

test('manual transaction and backup export/import preserve original features', async ({ page }) => {
  await boot(page);
  await nav(page, 'tx');
  const form = page.locator('#add-tx-form');
  await form.locator('[name="category"]').fill('ค่าเช่า');
  await form.locator('[name="desc"]').fill('ทดสอบค่าใช้จ่าย');
  await form.locator('[name="amount"]').fill('1200');
  await form.locator('[name="date"]').fill(today());
  await form.locator('button[type="submit"]').click();
  await expectSaved(page, db => db.transactions.length === 1);
  expect((await snapshot(page)).transactions[0]).toMatchObject({ type: 'expense', category: 'ค่าเช่า', amount: 1200 });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.data-tools summary').click();
  await page.locator('#export-btn').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString());
  expect(backup.version).toBe(9);
  expect(backup.transactions[0].amount).toBe(1200);

  const imported = { version: 3, ...inventory(), transactions: [{ id: 'imported-tx', type: 'income', category: 'รายรับอื่นๆ', desc: 'นำเข้า', amount: 77, date: today() }] };
  await page.locator('#import-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await expect(page.locator('#modal-overlay')).toHaveClass(/show/);
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => db.transactions[0]?.id === 'imported-tx');
  expect((await snapshot(page)).products).toEqual(imported.products);
});

for (const width of [1440, 390]) {
  test(`all ten sections remain reachable without page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    const seed = inventory();
    seed.transactions = [{ id: 'installment-fixture', type: 'installment', category: 'ขายสินค้า', desc: 'รายการผ่อนทดสอบ', amount: 500, paidAmount: 100, date: today(), dueDate: today(), productId: 'variant-1', qty: 2, profit: 300 }];
    const errors = await boot(page, seed);
    for (const tab of ['home', 'tasks', 'stock', 'ads', 'preorder', 'sell', 'installment', 'tx', 'report', 'ai']) {
      await nav(page, tab);
      await expect(page.locator('#tab-content')).not.toBeEmpty();
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(dimensions.scroll, `${tab} should scroll tables inside their container`).toBeLessThanOrEqual(dimensions.width + 1);
      if (tab === 'stock') {
        for (const workspace of ['add', 'pending', 'shipping', 'inventory']) {
          await page.locator(`[data-workspace-tab="${workspace}"]`).click();
          const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
          expect(size.scroll, `stock ${workspace} should fit the viewport`).toBeLessThanOrEqual(size.width + 1);
        }
      }
    }
    expect(errors).toEqual([]);
  });
}
