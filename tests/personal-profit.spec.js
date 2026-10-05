const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot, expectSaved, today } = require('./helpers');

test('checkout preview, reports and overview deduct personal money from gross sales exactly once', async ({ page }) => {
  const errors = await boot(page, inventory()); await nav(page, 'sell');
  const card = page.locator('.sell-card').first();
  await card.locator('.sell-qty').fill('2');
  await card.locator('.sell-shipping').fill('40');
  await card.locator('.sell-commission').fill('20');
  await card.locator('.sell-personal-percent').fill('20');
  await expect(card.locator('.sale-total-value')).toHaveText('฿500 / ฿140');
  await card.locator('.sell-submit').click();
  await expectSaved(page, s => s.transactions.some(t => t.personalUsePercent === 20));
  await nav(page, 'home');
  await expect(page.locator('.personal-use-stat .val')).toHaveText('฿100');
  await nav(page, 'report');
  await expect(page.locator('#report-range-summary .stat').filter({ has: page.locator('.lbl', { hasText: /^กำไรจากการขาย$/ }) }).locator('.val')).toHaveText('฿140');
  const salePanel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'กำไรตามรายการขาย', exact: true }) });
  await expect(salePanel.locator('tbody tr td').nth(7)).toHaveText('฿100');
  await expect(salePanel.locator('tbody tr td').nth(8)).toHaveText('฿140');
  const before = await snapshot(page);
  await nav(page, 'shipments'); await page.locator('.shipment-select').check();
  await page.locator('#shipment-cost').fill('10');
  await page.locator('#shipment-submit').click(); await page.locator('#modal-ok-btn').click();
  await expectSaved(page, s => s.shipments.length === 1);
  await nav(page, 'report'); await expect(salePanel.locator('tbody tr td').nth(8)).toHaveText('฿130');
  await nav(page, 'home'); await expect(page.locator('.personal-use-stat .val')).toHaveText('฿100');
  expect((await snapshot(page)).products).toEqual(before.products);
  expect(errors).toEqual([]);
});

test('existing sales, installments, zero percent, losses and campaign profit share use net personal profit', async ({ page }) => {
  const s = inventory();
  s.transactions = [
    { id: 'sale', type: 'income', category: 'ขายสินค้า', desc: 'เดิม', date: today(), qty: 2, amount: 500, profit: 240, personalUsePercent: 20, adCampaignId: 'ad', productId: 'variant-1' },
    { id: 'installment', type: 'installment', category: 'ขายสินค้า', desc: 'ผ่อน', date: today(), qty: 1, amount: 200, profit: 120, paidAmount: 0, personalUsePercent: 25 },
    { id: 'cancelled', type: 'income', category: 'ขายสินค้ายกเลิก', deliveryStatus: 'cancelled', desc: 'ยกเลิก', date: today(), qty: 1, amount: 999, profit: 900, personalUsePercent: 100 }
  ];
  await boot(page, s);
  await expect(page.locator('.personal-use-stat .val')).toHaveText('฿150');
  const result = await page.evaluate(async () => {
    const { saleProfit, personalUseAmount } = await import('/js/sale-finance.js');
    const { cashSummary } = await import('/js/store-tools.js');
    const { adMetrics } = await import('/js/ads.js');
    const { activeAccountingTransactions } = await import('/js/shipments.js');
    const txs = window.__testDB.transactions;
    const c = { id: 'ad', reservePercent: 20, startDate: txs[0].date, endDate: txs[0].date };
    return { summary: cashSummary(activeAccountingTransactions(txs)), campaign: adMetrics(c, txs, txs[0].date),
      loss: saleProfit({ amount: 500, profit: 40, personalUsePercent: 20 }), zero: saleProfit({ amount: 500, profit: 40 }), rounded: personalUseAmount({ amount: 99.99, personalUsePercent: 12.5 }) };
  });
  expect(result.summary).toMatchObject({ profit: 210, personalUse: 150, income: 500 });
  expect(result.campaign).toMatchObject({ grossProfit: 140, net: 140, percentReserve: 28 });
  expect(result.loss).toBe(-60); expect(result.zero).toBe(40); expect(result.rounded).toBe(12.5);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.personal-use-stat').screenshot({ path: 'test-results/personal-use-overview.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
});
