// คัดลอกค่าจาก Firebase Console > Project settings > Your apps > Web app
// ค่าเหล่านี้ระบุตัวโปรเจกต์ได้ แต่ไม่ได้เป็นรหัสลับ จึงวางไว้ฝั่งเว็บได้
export const firebaseConfig = {
  apiKey: "AIzaSyDXdSpL_Qcbdx31Eif0bP8fDI0Yy0y6K08",
  authDomain: "crazsix-stock.firebaseapp.com",
  projectId: "crazsix-stock",
  storageBucket: "crazsix-stock.firebasestorage.app",
  messagingSenderId: "397141289819",
  appId: "1:397141289819:web:c5bb8338d6e21f1e31487e",
  measurementId: "G-K3FJ71DZ8B"
};

// เปลี่ยนค่านี้เมื่อต้องการแยกข้อมูลของคนละร้านใน Firebase โปรเจกต์เดียวกัน
export const storeId = 'crazsix-store';
