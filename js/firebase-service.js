import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  runTransaction,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, storeId } from "./firebase-config.js";

const requiredKeys = ["apiKey", "authDomain", "projectId", "appId"];
const isConfigured = requiredKeys.every((key) => {
  const value = firebaseConfig[key];
  return value && !value.startsWith("PASTE_YOUR_");
});

export { isConfigured as firebaseConfigured };

let db;

function withTimeout(promise, operation) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${operation} ใช้เวลานานเกิน 15 วินาที`)),
      15000,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function database() {
  if (!isConfigured) {
    throw new Error(
      "ยังไม่ได้ตั้งค่า Firebase: แก้ไฟล์ js/firebase-config.js ก่อนใช้งาน",
    );
  }
  if (!db) db = getFirestore(initializeApp(firebaseConfig));
  return db;
}

function documentRef(name) {
  return doc(database(), "stores", storeId, "data", name);
}

// Firestore may return map keys in a different order after a round trip.
function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, comparable(value[key])]));
  return value;
}

/**
 * ชั้นข้อมูลกลางสำหรับแอปสต็อก
 * เอกสารถูกแยกตามชนิดข้อมูล: products, transactions, pendingOrders, preorders, adCampaigns
 */
export const stockDatabase = {
  async get(name) {
    const snapshot = await withTimeout(
      getDoc(documentRef(name)),
      "การเชื่อมต่อ Firebase",
    );
    return snapshot.exists() ? snapshot.data().value : null;
  },

  async set(name, value) {
    await setDoc(documentRef(name), {
      value,
      updatedAt: serverTimestamp(),
    });
  },

  async setMany(values, expected) {
    // Reject stale edits instead of replacing another device's sale or payment.
    // No UI mutations inside the retryable Firestore transaction callback.
    const names = Object.keys(values);
    await runTransaction(database(), async transaction => {
      const snapshots = await Promise.all(names.map(name => transaction.get(documentRef(name))));
      names.forEach((name, index) => {
        const snapshot = snapshots[index];
        const current = snapshot.exists() ? snapshot.data().value : [];
        if (!expected || JSON.stringify(comparable(current || [])) !== JSON.stringify(comparable(expected[name] || []))) {
          const error = new Error("ข้อมูลเปลี่ยนจากอุปกรณ์อื่น กรุณาตรวจสอบข้อมูลล่าสุดแล้วลองอีกครั้ง");
          error.code = "store/conflict";
          throw error;
        }
      });
      names.forEach(name => transaction.set(documentRef(name), { value: values[name], updatedAt: serverTimestamp() }));
    });
  },

  subscribe(name, onValue, onError) {
    return onSnapshot(
      documentRef(name),
      (snapshot) => {
        // The action owns optimistic state until its entire batch is committed.
        if (!snapshot.metadata.hasPendingWrites) {
          onValue(snapshot.exists() ? snapshot.data().value : null);
        }
      },
      onError,
    );
  },
};
