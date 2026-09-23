import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  writeBatch,
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

/**
 * ชั้นข้อมูลกลางสำหรับแอปสต็อก
 * เอกสารถูกแยกตามชนิดข้อมูล: products, transactions และ pendingOrders
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

  async setMany(values) {
    const batch = writeBatch(database());
    Object.entries(values).forEach(([name, value]) => {
      batch.set(documentRef(name), { value, updatedAt: serverTimestamp() });
    });
    await batch.commit();
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
