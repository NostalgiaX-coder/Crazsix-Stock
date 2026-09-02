import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig, storeId } from './firebase-config.js';

const requiredKeys = ['apiKey', 'authDomain', 'projectId', 'appId'];
const isConfigured = requiredKeys.every((key) => {
  const value = firebaseConfig[key];
  return value && !value.startsWith('PASTE_YOUR_');
});

export { isConfigured as firebaseConfigured };

let db;

function database() {
  if (!isConfigured) {
    throw new Error('ยังไม่ได้ตั้งค่า Firebase: แก้ไฟล์ js/firebase-config.js ก่อนใช้งาน');
  }
  if (!db) db = getFirestore(initializeApp(firebaseConfig));
  return db;
}

function documentRef(name) {
  return doc(database(), 'stores', storeId, 'data', name);
}

/**
 * ชั้นข้อมูลกลางสำหรับแอปสต็อก
 * เอกสารถูกแยกตามชนิดข้อมูล: products, transactions และ pendingOrders
 */
export const stockDatabase = {
  async get(name) {
    const snapshot = await getDoc(documentRef(name));
    return snapshot.exists() ? snapshot.data().value : null;
  },

  async set(name, value) {
    await setDoc(documentRef(name), {
      value,
      updatedAt: serverTimestamp()
    });
  },

  subscribe(name, onValue) {
    return onSnapshot(documentRef(name), (snapshot) => {
      onValue(snapshot.exists() ? snapshot.data().value : null);
    });
  }
};
