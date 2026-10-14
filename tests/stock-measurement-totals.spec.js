const { test, expect } = require('@playwright/test');
const { boot, nav, inventory, snapshot } = require('./helpers');

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
  await row.locator('summary').click();
  await expect(row.locator('[data-edit="plain"]')).toBeVisible();
  await page.locator('#stock-search').fill('อก 22');
  await expect(page.locator('#stock-visible-totals')).toContainText('3 ชิ้น');
  const download = page.waitForEvent('download');
  await page.locator('#stock-export-filtered').click();
  const stream = await (await download).createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString();
  expect(csv).toContain('plain');
  expect(csv).toContain('measured');
  expect(csv).not.toContain('used');
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(row.locator('[data-edit="plain"]')).toBeVisible();
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
