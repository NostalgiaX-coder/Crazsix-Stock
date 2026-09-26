const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');

function supplierSeed() {
  const state = inventory();
  state.pendingOrders = [{ id: 'supplier-1', name: 'เสื้อ Crazsix', color: 'ดำ', size: 'M', type: 'new', cost: 120, price: 250, qty: 5, orderDate: today(), note: 'ร้านตัวอย่าง' }];
  state.transactions = [{ id: 'purchase', type: 'expense', category: 'สั่งซื้อสินค้า (รอของมาส่ง)', amount: 600, date: today(), pendingIds: ['supplier-1'] }];
  return state;
}
async function pending(page) {
  await nav(page, 'stock');
  await page.locator('[data-workspace-tab="pending"]').click();
  await page.locator('.pending-select').check();
}
async function downloadText(page, selector) {
  const promise = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await promise;
  const stream = await download.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

test('partial supplier receipts preserve the remainder and average cost without duplicate purchasing expenses', async ({ page }) => {
  await boot(page, supplierSeed());
  await pending(page);
  await page.locator('.pending-receive-qty').fill('2');
  await page.locator('#pending-bulk-ship').fill('30');
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders[0]?.qty === 3);
  let db = await snapshot(page);
  expect(db.pendingOrders[0]).toMatchObject({ originalQty: 5, receivedQty: 2 });
  expect(db.products[0].variants[0].qty).toBe(12);
  expect(db.products[0].variants[0].cost).toBeCloseTo(1240 / 12); // (1000 + 240) / 12
  await page.locator('.pending-select').check();
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders.length === 0);
  db = await snapshot(page);
  expect(db.products[0].variants[0].qty).toBe(15);
  expect(db.products[0].variants[0].cost).toBeCloseTo(1600 / 15);
  expect(db.transactions.map(tx => tx.amount).sort((a, b) => a - b)).toEqual([30, 600]);
});

test('invalid receipt quantities and failed writes preserve supplier and inventory data', async ({ page }) => {
  const state = supplierSeed();
  await boot(page, state);
  await pending(page);
  await page.locator('.pending-receive-qty').fill('6');
  await page.locator('#pending-receive-selected').click();
  await expect(page.locator('#modal-overlay')).toContainText('ไม่เกินจำนวนที่รอรับ');
  expect(await snapshot(page)).toEqual(state);
  await page.locator('#modal-ok-btn').click();
  await page.locator('.pending-receive-qty').fill('2');
  await page.evaluate(() => { window.__testSaveError = 'Offline'; });
  await page.locator('#pending-receive-selected').click();
  await expect(page.locator('#modal-overlay')).toContainText('บันทึกไม่สำเร็จ');
  expect(await snapshot(page)).toEqual(state);
  await page.locator('#modal-ok-btn').click();
  await page.evaluate(() => { window.__testSaveError = null; });
  await page.locator('#pending-receive-selected').click();
  await expectSaved(page, db => db.pendingOrders[0].qty === 3 && db.products[0].variants[0].qty === 12);
});

test('follow-ups distinguish supplier stock, customer preorders and installments and link to their source', async ({ page }) => {
  const state = supplierSeed();
  state.preorders = [{ id: 'po-1', customer: 'คุณเอ', contact: '', name: 'สินค้าพรี', color: '', size: '', type: 'new', qty: 1, unitPrice: 200, paidAmount: 0, refundedAmount: 0, status: 'awaiting', createdAt: today(), updatedAt: today(), dueDate: '2020-01-01', note: '' }];
  state.transactions.push({ id: 'debt', type: 'installment', desc: 'ผ่อนสินค้า', amount: 300, paidAmount: 100, date: today(), dueDate: '2020-01-01' });
  const errors = await boot(page, state);
  await nav(page, 'tasks');
  await expect(page.locator('[data-task-kind]:visible')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/tasks-desktop.png', fullPage: true });
  await page.locator('#task-filter').selectOption('urgent');
  await expect(page.locator('[data-task-kind]:visible')).toHaveCount(2);
  await page.locator('#task-filter').selectOption('supplier');
  await expect(page.locator('[data-task-kind]:visible')).toContainText('ร้านสั่งรอรับ');
  await page.locator('[data-task-kind]:visible button').click();
  await expect(page.locator('#workspace-pending')).toBeVisible();
  await nav(page, 'tasks');
  await page.locator('#task-filter').selectOption('preorder');
  await page.locator('[data-task-kind]:visible button').click();
  await expect(page.locator('[data-preorder]:visible')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('range reports distinguish cash from sales, validate dates and export only the selected period', async ({ page }) => {
  const state = inventory();
  state.transactions = [
    { id: 'old', type: 'income', amount: 100, date: '2026-08-01', desc: 'เดือนก่อน' },
    { id: 'sale', type: 'installment', category: 'ขายสินค้า', amount: 500, paidAmount: 100, profit: 300, qty: 2, date: '2026-09-02', desc: 'ยอดขายผ่อน' },
    { id: 'deposit', type: 'income', amount: 100, date: '2026-09-02', installmentId: 'sale', desc: 'มัดจำ' },
    { id: 'expense', type: 'expense', amount: 50, date: '2026-09-03', desc: 'ค่าส่ง' }
  ];
  await boot(page, state);
  await nav(page, 'report');
  await page.locator('#report-from').fill('2026-09-01');
  await page.locator('#report-to').fill('2026-09-30');
  await expect(page.locator('#report-range-summary .val')).toHaveText(['฿100', '฿50', '฿50', '฿300', '฿0', '฿300']);
  const csv = await downloadText(page, '#report-export');
  expect(csv).toContain('ยอดขายผ่อน'); expect(csv).not.toContain('เดือนก่อน');
  await page.locator('#report-from').fill('2026-10-01');
  await expect(page.locator('#report-range-error')).toContainText('วันที่เริ่มต้น');
  await expect(page.locator('#report-export')).toBeDisabled();
  await page.locator('#report-clear').click();
  await expect(page.locator('#report-range-summary .val')).toHaveText(['฿200', '฿50', '฿150', '฿300', '฿0', '฿300']);
});

test('CSV exports follow account filters and escape formulas, quotes and line breaks', async ({ page }) => {
  const state = inventory();
  state.transactions = [
    { id: 'unsafe', type: 'expense', amount: 10, date: today(), category: 'ทดสอบ', desc: '=SUM(1,2)\n"หมายเหตุ"' },
    { id: 'excluded', type: 'income', amount: 20, date: today(), category: 'รายรับ', desc: 'ไม่ส่งออก' }
  ];
  await boot(page, state);
  await nav(page, 'tx');
  await page.locator('#tx-type-filter').selectOption('expense');
  const csv = await downloadText(page, '[data-export="filtered-transactions"]');
  expect(csv.charCodeAt(0)).toBe(0xFEFF);
  expect(csv).toContain('"\'=SUM(1,2)\n""หมายเหตุ"""');
  expect(csv).not.toContain('ไม่ส่งออก');
  await page.locator('.data-tools summary').click();
  const stock = await downloadText(page, '[data-export="inventory"]');
  expect(stock).toContain('variant-1'); expect(stock).toContain('เสื้อ Crazsix');
});

test('manual entries can be edited without creating another transaction and reject stale edits', async ({ page }) => {
  const state = inventory();
  state.transactions = [{ id: 'rent', type: 'expense', category: 'ค่าเช่า', desc: 'ค่าเช่าร้าน', amount: 100, date: today() }];
  await boot(page, state);
  await nav(page, 'tx');
  await page.locator('[data-txedit="rent"]').click();
  await expect(page.locator('#add-tx-form [name="amount"]')).toHaveValue('100');
  await page.locator('#add-tx-form [name="amount"]').fill('200');
  await page.locator('#add-tx-form [type="submit"]').click();
  await expectSaved(page, db => db.transactions[0].amount === 200);
  expect((await snapshot(page)).transactions).toHaveLength(1);
  await page.locator('[data-txedit="rent"]').click();
  await page.locator('#add-tx-form [name="amount"]').fill('300');
  await page.evaluate(() => {
    window.__testDB.transactions[0].amount = 400;
    window.__testSubscribers.transactions(structuredClone(window.__testDB.transactions));
  });
  await page.locator('#add-tx-form [type="submit"]').click();
  await expect(page.locator('#modal-overlay')).toContainText('รายการบัญชีเปลี่ยนแปลงแล้ว');
  expect((await snapshot(page)).transactions[0].amount).toBe(400);
});

test('leaving reports destroys chart instances instead of retaining detached canvases', async ({ page }) => {
  const state = inventory();
  state.transactions = [{ id: 'sale', type: 'income', amount: 100, category: 'ขายสินค้า', productId: 'variant-1', qty: 1, profit: 50, date: today() }];
  await boot(page, state);
  await nav(page, 'report');
  await expect.poll(() => page.evaluate(() => Object.keys(window.Chart.instances).length)).toBe(2);
  await nav(page, 'home');
  await expect.poll(() => page.evaluate(() => Object.keys(window.Chart.instances).length)).toBe(0);
});

for (const width of [390, 1440]) {
  test(`new follow-up, receipt and report controls fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = await boot(page, supplierSeed());
    for (const tab of ['tasks', 'report', 'stock']) {
      await nav(page, tab);
      if (tab === 'stock') {
        await page.locator('[data-workspace-tab="pending"]').click();
        const info = await page.locator('#workspace-pending .variant-info').boundingBox();
        expect(info.width).toBeGreaterThan(140);
      }
      if (width === 390) await page.screenshot({ path: `test-results/${tab}-mobile.png`, fullPage: true });
      const size = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(size[0], tab).toBeLessThanOrEqual(size[1] + 1);
    }
    expect(errors).toEqual([]);
  });
}

test('backup rejects executable identifiers and invalid installment due dates before writing', async ({ page }) => {
  const state = inventory();
  await boot(page, state);
  const upload = async data => page.locator('#import-input').setInputFiles({ name: 'unsafe.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  const malformed = structuredClone(state);
  malformed.products[0].id = '" onclick="alert(1)';
  await upload(malformed);
  await expect(page.locator('#modal-overlay')).toContainText('อักขระที่ไม่รองรับ');
  await page.locator('#modal-ok-btn').click();
  malformed.products = state.products;
  malformed.transactions = [{ id: 'bad-date', type: 'installment', amount: 100, paidAmount: 0, date: today(), dueDate: '<img src=x onerror=alert(1)>' }];
  await upload(malformed);
  await expect(page.locator('#modal-overlay')).toContainText('วันที่ไม่ถูกต้อง');
  expect(await page.evaluate(() => window.__testWrites.length)).toBe(0);
});

test('deleting a changed ledger entry requires a fresh confirmation', async ({ page }) => {
  const state = inventory();
  state.transactions = [{ id: 'expense', type: 'expense', amount: 100, date: today(), desc: 'ค่าใช้จ่าย' }];
  await boot(page, state);
  await nav(page, 'tx');
  await page.locator('[data-txdel="expense"]').click();
  await page.evaluate(() => {
    window.__testDB.transactions[0].amount = 200;
    window.__testSubscribers.transactions(structuredClone(window.__testDB.transactions));
  });
  await page.locator('#modal-ok-btn').click();
  await expect(page.locator('#modal-overlay')).toContainText('เปลี่ยนแปลงระหว่างยืนยัน');
  expect((await snapshot(page)).transactions[0].amount).toBe(200);
  expect(await page.evaluate(() => window.__testWrites.length)).toBe(0);
});
