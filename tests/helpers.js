const { expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(new Date());
const inventory = () => ({
  products: [{ id: 'product-1', name: 'เสื้อ Crazsix', image: null, colorImages: {}, createdAt: today(), variants: [
    { id: 'variant-1', color: 'ดำ', size: 'M', type: 'new', cost: 100, price: 250, qty: 10, createdAt: today() },
    { id: 'variant-2', color: 'ขาว', size: 'L', type: 'used', cost: 80, price: 200, qty: 1, createdAt: today() }
  ] }],
  transactions: [],
  pendingOrders: []
});

// Every context gets an independent in-memory database. The production Firebase
// module is replaced before its first request; all other remote traffic is blocked.
async function boot(page, initial = inventory()) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(seed => {
    window.__testDB = structuredClone(seed);
    window.__testWrites = [];
    window.__testSubscribers = {};
  }, initial);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.includes('/chart.js/')) {
      const chart = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
      return route.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(chart, 'utf8') });
    }
    if (url.origin !== 'http://127.0.0.1:4173') return route.abort();
    if (url.pathname === '/js/firebase-service.js') {
      return route.fulfill({ contentType: 'text/javascript', body: `
        export const firebaseConfigured = true;
        export const stockDatabase = {
          async get(name) { return structuredClone(window.__testDB[name] ?? null); },
          async set(name, value) {
            window.__testDB[name] = structuredClone(value);
            window.__testWrites.push({ name, value: structuredClone(value) });
          },
          async setMany(values) {
            if (window.__testSaveDelay) await new Promise(resolve => setTimeout(resolve, window.__testSaveDelay));
            if (window.__testSaveError) throw new Error(window.__testSaveError);
            const next = structuredClone(values);
            Object.assign(window.__testDB, next);
            window.__testWrites.push({ values: next });
          },
          subscribe(name, callback) {
            window.__testSubscribers[name] = callback;
            return () => { delete window.__testSubscribers[name]; };
          }
        };
      ` });
    }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.locator('[data-tab="home"]').first()).toBeVisible();
  return errors;
}

async function nav(page, tab) {
  await page.locator(`[data-tab="${tab}"]`).first().click();
}

async function radio(page, selector) {
  await page.locator(selector).locator('..').click();
}

async function snapshot(page) {
  return page.evaluate(() => structuredClone(window.__testDB));
}

async function expectSaved(page, check) {
  await expect.poll(async () => check(await snapshot(page))).toBeTruthy();
}

module.exports = { boot, nav, radio, inventory, snapshot, expectSaved, today };
