const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the real adapter, replacing only the Firebase SDK boundary.
// The browser flows use an in-memory store separately; no production writes here.
function adapter(initial) {
  const stored = structuredClone(initial), commits = [];
  const source = fs.readFileSync(path.join(__dirname, '../js/firebase-service.js'), 'utf8')
    .replace(/import[\s\S]*?from\s+"[^"]+";/g, '')
    .replace('export { isConfigured as firebaseConfigured };', '')
    .replace('export const stockDatabase', 'const stockDatabase');
  const sdk = {
    firebaseConfig: { apiKey: 'test', authDomain: 'test', projectId: 'test', appId: 'test' },
    storeId: 'test', initializeApp: () => ({}), getFirestore: () => ({}),
    doc: (_db, _stores, _storeId, _data, name) => name,
    getDoc: async name => ({ exists: () => name in stored, data: () => ({ value: stored[name] }) }),
    setDoc: async () => { throw new Error('Unexpected non-atomic write'); },
    serverTimestamp: () => 'server-time', onSnapshot: () => () => {},
    runTransaction: async (_db, callback) => {
      const writes = {};
      await callback({
        get: async name => {
          expect(Object.keys(writes)).toHaveLength(0); // all reads must precede all writes
          return { exists: () => name in stored, data: () => ({ value: structuredClone(stored[name]) }) };
        },
        set: (name, document) => { writes[name] = document.value; }
      });
      Object.assign(stored, structuredClone(writes)); commits.push(writes);
    }
  };
  const service = new Function(...Object.keys(sdk), `${source}\nreturn stockDatabase;`)(...Object.values(sdk));
  return { service, stored, commits };
}

test('real Firestore adapter accepts reordered map keys and creates a missing preorder document atomically', async () => {
  const { service, stored, commits } = adapter({ products: [{ qty: 2, id: 'v1' }], transactions: [] });
  const expected = { products: [{ id: 'v1', qty: 2 }], transactions: [], preorders: [] };
  const next = { products: [{ id: 'v1', qty: 1 }], transactions: [{ id: 'payment' }], preorders: [{ id: 'order' }] };
  await service.setMany(next, expected);
  expect(stored).toEqual(next);
  expect(commits).toHaveLength(1);
});

test('real Firestore adapter rejects a stale store without writing any participating document', async () => {
  const initial = { products: [{ id: 'v1', qty: 1 }], transactions: [{ id: 'other-device-sale' }] };
  const { service, stored, commits } = adapter(initial);
  await expect(service.setMany({ products: [], transactions: [] }, { products: [{ id: 'v1', qty: 2 }], transactions: [] })).rejects.toMatchObject({ code: 'store/conflict' });
  expect(stored).toEqual(initial);
  expect(commits).toEqual([]);
});

test('real Firestore adapter refuses writes without a confirmed snapshot', async () => {
  const { service, commits } = adapter({ products: [] });
  await expect(service.setMany({ products: [] })).rejects.toMatchObject({ code: 'store/conflict' });
  expect(commits).toEqual([]);
});
