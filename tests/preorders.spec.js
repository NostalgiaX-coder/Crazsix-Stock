const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');

const order = (overrides = {}) => ({
  id: 'preorder-1', customer: 'คุณเอ', contact: 'LINE: customer-a', name: 'เสื้อพรีลูกค้า',
  color: 'ดำ', size: 'M', type: 'new', qty: 2, unitPrice: 250, paidAmount: 0,
  refundedAmount: 0, note: 'ส่งเมื่อครบ', dueDate: today(), createdAt: today(), updatedAt: today(), status: 'awaiting', ...overrides
});
function seeded(overrides = {}) {
  const state = inventory();
  state.preorders = [order(overrides)];
  if (state.preorders[0].paidAmount) state.transactions = [{ id: 'deposit-1', type: 'income', category: 'มัดจำ pre-order', amount: state.preorders[0].paidAmount, date: today(), preorderId: 'preorder-1', desc: 'มัดจำคุณเอ' }];
  return state;
}
async function create(page, deposit = '100') {
  await nav(page, 'preorder');
  await page.locator('#preorder-create summary').click();
  const form = page.locator('#preorder-form');
  await form.locator('[name="customer"]').fill('คุณเอ');
  await form.locator('[name="contact"]').fill('LINE: customer-a');
  await form.locator('[name="name"]').fill('เสื้อพรีลูกค้า');
  await form.locator('[name="qty"]').fill('2');
  await form.locator('[name="unitPrice"]').fill('250');
  await form.locator('[name="deposit"]').fill(deposit);
  await form.locator('[type="submit"]').click();
}
async function submitDelivery(page, source = 'direct') {
  await page.locator('.preorder-delivery summary').click();
  const form = page.locator('.preorder-fulfill');
  await form.locator('[name="source"]').selectOption(source);
  if (source === 'direct') await form.locator('[name="unitCost"]').fill('100');
  else await form.locator('[name="variantId"]').selectOption('variant-1');
  await form.locator('[name="shipping"]').fill('30');
  await form.locator('[name="commission"]').fill('10');
  await form.locator('[type="submit"]').click();
  await page.locator('#modal-ok-btn').click();
}

test('customer preorders remain separate from supplier purchases throughout deposit, payment and direct fulfillment', async ({ page }) => {
  const state = inventory();
  state.pendingOrders = [{ id: 'supplier-order', name: 'ของร้าน', color: '', size: '', type: 'new', qty: 5, cost: 100, price: 200, orderDate: today() }];
  const errors = await boot(page, state);
  await create(page);
  await expectSaved(page, db => db.preorders?.length === 1 && db.transactions.length === 1);
  expect((await snapshot(page)).pendingOrders).toEqual(state.pendingOrders);
  expect((await snapshot(page)).products).toEqual(state.products);
  await page.locator('.preorder-payment [name="amount"]').fill('400');
  await page.locator('.preorder-payment button').click();
  await expectSaved(page, db => db.preorders[0].paidAmount === 500);
  for (const status of ['ordered', 'ready']) {
    await page.locator('[data-preorder-action="status"]').click();
    await expectSaved(page, db => db.preorders[0].status === status);
  }
  await page.screenshot({ path: 'test-results/preorder-desktop.png', fullPage: true });
  await submitDelivery(page);
  await expectSaved(page, db => db.preorders[0].status === 'completed');
  const db = await snapshot(page);
  expect(db.products).toEqual(state.products);
  expect(db.pendingOrders).toEqual(state.pendingOrders);
  expect(db.transactions.filter(tx => tx.type === 'income').reduce((sum, tx) => sum + tx.amount, 0)).toBe(500);
  expect(db.transactions.filter(tx => tx.type === 'expense').reduce((sum, tx) => sum + tx.amount, 0)).toBe(240);
  expect(db.transactions.find(tx => tx.type === 'preorder')).toMatchObject({ amount: 500, profit: 260, qty: 2, unitCost: 100 });
  await nav(page, 'report');
  await expect(page.locator('#tab-content')).toContainText('เสื้อพรีลูกค้า');
  await nav(page, 'installment');
  await expect(page.locator('#tab-content')).not.toContainText('คุณเอ');
  await nav(page, 'tx');
  await page.locator('#tx-type-filter').selectOption('preorder');
  await expect(page.locator('[data-txdel]:visible')).toHaveCount(1);
  await page.locator('[data-txdel]:visible').click();
  await expect(page.locator('[data-preorder]:visible')).toHaveCount(1);
  await expect(page.locator('[data-preorder]:visible')).toContainText('ส่งมอบแล้ว');
  expect(errors).toEqual([]);
});

test('fulfillment from stock deducts once without buying the same inventory again', async ({ page }) => {
  const state = seeded({ status: 'ready', paidAmount: 500 });
  await boot(page, state);
  await nav(page, 'preorder');
  await submitDelivery(page, 'stock');
  await expectSaved(page, db => db.preorders[0].status === 'completed');
  const db = await snapshot(page);
  expect(db.products[0].variants[0].qty).toBe(8);
  expect(db.transactions.filter(tx => tx.type === 'expense').map(tx => tx.amount).sort((a, b) => a - b)).toEqual([10, 30]);
  expect(db.transactions.find(tx => tx.type === 'preorder')).toMatchObject({ productId: 'variant-1', profit: 260 });
});

test('cancelling a customer preorder records a full refund and retains history', async ({ page }) => {
  const state = seeded({ paidAmount: 100 });
  await boot(page, state);
  await nav(page, 'preorder');
  await page.locator('[data-preorder-action="cancel"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('฿100');
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => db.preorders[0].status === 'cancelled');
  const db = await snapshot(page);
  expect(db.preorders[0]).toMatchObject({ paidAmount: 100, refundedAmount: 100 });
  expect(db.transactions.filter(tx => tx.type === 'expense')).toHaveLength(1);
  expect(db.transactions.find(tx => tx.type === 'expense')).toMatchObject({ amount: 100, category: 'คืนเงิน pre-order' });
  expect(db.products).toEqual(state.products);
  await page.locator('#preorder-filter').selectOption('cancelled');
  await expect(page.locator('[data-preorder]:visible')).toContainText('คืนเงินแล้ว');
  await expect(page.locator('[data-preorder-action]')).toHaveCount(0);
});

test('invalid deposits, edits below paid total, and incomplete payments cannot close orders', async ({ page }) => {
  await boot(page);
  await create(page, '600');
  await expect(page.locator('#modal-overlay')).toContainText('ยอดรับเงินต้องไม่เกิน');
  expect((await snapshot(page)).preorders).toEqual([]);
  await page.locator('#modal-ok-btn').click();
  await page.locator('#preorder-form [name="deposit"]').fill('100');
  await page.locator('#preorder-form [type="submit"]').click();
  await expectSaved(page, db => db.preorders.length === 1);
  await page.getByText('แก้ไขข้อมูลการจอง', { exact: true }).click();
  await page.locator('.preorder-edit [name="unitPrice"]').fill('10');
  await page.locator('.preorder-edit [type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('ยอดรับเงินต้องไม่เกิน');
  await page.locator('#modal-ok-btn').click();
  expect((await snapshot(page)).preorders[0].unitPrice).toBe(250);
  for (const status of ['ordered', 'ready']) {
    await page.locator('[data-preorder-action="status"]').click();
    await expectSaved(page, db => db.preorders[0].status === status);
  }
  await submitDelivery(page);
  await expect(page.locator('#modal-overlay')).toContainText('ต้องรับชำระครบ');
  expect((await snapshot(page)).preorders[0].status).toBe('ready');
  expect((await snapshot(page)).transactions).toHaveLength(1);
});

test('save failures keep the preorder form and retry does not duplicate the deposit', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { window.__testSaveError = 'Offline'; });
  await create(page);
  await expect(page.locator('#modal-overlay')).toContainText('บันทึกไม่สำเร็จ');
  expect((await snapshot(page)).transactions).toEqual([]);
  await page.locator('#modal-ok-btn').click();
  await expect(page.locator('#preorder-form [name="customer"]')).toHaveValue('คุณเอ');
  await page.evaluate(() => { window.__testSaveError = null; window.__testSaveDelay = 300; });
  await page.locator('#preorder-form [type="submit"]').dblclick();
  await expectSaved(page, db => db.preorders.length === 1);
  expect((await snapshot(page)).transactions).toHaveLength(1);
});

test('atomic fulfillment failure restores stock, order status and accounting for retry', async ({ page }) => {
  const state = seeded({ status: 'ready', paidAmount: 500 });
  await boot(page, state);
  await nav(page, 'preorder');
  await page.evaluate(() => { window.__testSaveError = 'Offline'; });
  await submitDelivery(page, 'stock');
  await expect(page.locator('#modal-overlay')).toContainText('บันทึกไม่สำเร็จ');
  expect(await snapshot(page)).toEqual(state);
  await page.locator('#modal-ok-btn').click();
  await page.evaluate(() => { window.__testSaveError = null; });
  await page.locator('.preorder-fulfill [type="submit"]').click();
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => db.preorders[0].status === 'completed');
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(8);
});

test('stale sale conflicts preserve the other device data and allow a refreshed retry', async ({ page }) => {
  await boot(page);
  await nav(page, 'sell');
  await page.evaluate(() => { window.__testDB.products[0].variants[0].qty = 3; });
  await page.locator('.sell-submit').first().click();
  await expect(page.locator('#modal-overlay')).toContainText('อุปกรณ์อื่น');
  expect((await snapshot(page)).products[0].variants[0].qty).toBe(3);
  expect((await snapshot(page)).transactions).toEqual([]);
  await page.locator('#modal-ok-btn').click();
  await nav(page, 'sell');
  await page.locator('.sell-submit').first().click();
  await expectSaved(page, db => db.products[0].variants[0].qty === 2 && db.transactions.length === 1);
});

test('backup round trip preserves customer orders; mismatched payments and duplicate IDs are rejected', async ({ page }) => {
  const state = seeded({ paidAmount: 100 });
  await boot(page, state);
  await page.locator('.data-tools summary').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const stream = await (await downloaded).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  expect(data).toMatchObject({ version: 4, preorders: state.preorders });
  const upload = async payload => page.locator('#import-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)) });
  await upload(data);
  await page.locator('#modal-ok-btn').click();
  await expect.poll(() => page.evaluate(() => window.__testWrites.length)).toBe(1);
  expect((await snapshot(page)).preorders).toEqual(state.preorders);
  await upload({ ...data, transactions: [] });
  await expect(page.locator('#modal-overlay')).toContainText('ไม่ตรงกับบัญชี');
  await page.locator('#modal-ok-btn').click();
  await upload({ ...data, preorders: [...data.preorders, ...data.preorders] });
  await expect(page.locator('#modal-overlay')).toContainText('รหัสรายการซ้ำ');
  expect(await page.evaluate(() => window.__testWrites.length)).toBe(1);
});

test('mobile preorder search, overdue filtering and editing fit the screen and escape customer text', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = seeded({ customer: '<img src=x onerror=alert(1)>', dueDate: '2020-01-01', note: 'ข้อความ'.repeat(100) });
  const errors = await boot(page, state);
  await nav(page, 'preorder');
  await page.locator('#preorder-filter').selectOption('overdue');
  await expect(page.locator('[data-preorder]:visible')).toHaveCount(1);
  await expect(page.locator('.preorder-card img')).toHaveCount(0);
  await page.locator('#preorder-search').fill('ไม่พบ');
  await expect(page.locator('#preorder-empty')).toBeVisible();
  await page.locator('#preorder-clear').click();
  await page.getByText('แก้ไขข้อมูลการจอง', { exact: true }).click();
  await page.locator('.preorder-edit [name="customer"]').fill('คุณบี');
  await page.locator('.preorder-edit [name="dueDate"]').fill(today());
  await page.locator('.preorder-edit [type="submit"]').click();
  await expectSaved(page, db => db.preorders[0].customer === 'คุณบี');
  await page.screenshot({ path: 'test-results/preorder-mobile.png', fullPage: true });
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  expect(errors).toEqual([]);
});

test('insufficient stock does not consume payment or close a ready preorder', async ({ page }) => {
  const state = seeded({ status: 'ready', paidAmount: 500 });
  state.products[0].variants[0].qty = 1;
  await boot(page, state);
  await nav(page, 'preorder');
  await submitDelivery(page, 'stock');
  await expect(page.locator('#modal-overlay')).toContainText('สต็อกไม่พอ');
  expect(await snapshot(page)).toEqual(state);
});

test('previously recorded direct costs are used for profit without adding another expense', async ({ page }) => {
  const state = seeded({ status: 'ready', paidAmount: 500 });
  state.transactions.push({ id: 'purchase', type: 'expense', category: 'จัดหาของลูกค้า', amount: 200, date: today() });
  await boot(page, state);
  await nav(page, 'preorder');
  await page.locator('.preorder-delivery summary').click();
  await page.locator('.preorder-fulfill [name="unitCost"]').fill('100');
  await page.locator('[name="costRecorded"]').check();
  await page.locator('.preorder-fulfill [type="submit"]').click();
  await page.locator('#modal-ok-btn').click();
  await expectSaved(page, db => db.preorders[0].status === 'completed');
  const db = await snapshot(page);
  expect(db.transactions.filter(tx => tx.type === 'expense')).toHaveLength(1);
  expect(db.transactions.find(tx => tx.type === 'preorder').profit).toBe(300);
});

test('installment deposits above the sale total are rejected rather than silently changed', async ({ page }) => {
  const state = inventory();
  await boot(page, state);
  await nav(page, 'sell');
  const card = page.locator('[data-sale-card]').first();
  await card.locator('.sell-installment').check();
  await card.locator('.sell-deposit').fill('999');
  await card.locator('.sell-submit').click();
  await expect(page.locator('#modal-overlay')).toContainText('มัดจำต้องตั้งแต่ 0');
  expect(await snapshot(page)).toEqual(state);
});

test('a changed payment during cancellation confirmation requires a new review', async ({ page }) => {
  await boot(page, seeded({ paidAmount: 100 }));
  await nav(page, 'preorder');
  await page.locator('[data-preorder-action="cancel"]').click();
  await page.evaluate(() => {
    window.__testDB.preorders[0].paidAmount = 200;
    window.__testDB.transactions.push({ id: 'other-payment', type: 'income', category: 'รับชำระ pre-order', amount: 100, preorderId: 'preorder-1', date: window.__testDB.preorders[0].createdAt });
    window.__testSubscribers.preorders(structuredClone(window.__testDB.preorders));
    window.__testSubscribers.transactions(structuredClone(window.__testDB.transactions));
  });
  await page.locator('#modal-ok-btn').click();
  await expect(page.locator('#modal-overlay')).toContainText('รายการเปลี่ยนแปลงระหว่างยืนยัน');
  const db = await snapshot(page);
  expect(db.preorders[0]).toMatchObject({ status: 'awaiting', paidAmount: 200, refundedAmount: 0 });
  expect(db.transactions.filter(tx => tx.type === 'expense')).toEqual([]);
  expect(await page.evaluate(() => window.__testWrites.length)).toBe(0);
});
