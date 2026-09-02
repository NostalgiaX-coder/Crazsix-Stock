// คัดลอกค่าจาก Firebase Console > Project settings > Your apps > Web app
// ค่าเหล่านี้ระบุตัวโปรเจกต์ได้ แต่ไม่ได้เป็นรหัสลับ จึงวางไว้ฝั่งเว็บได้
export const firebaseConfig = {
  apiKey: 'PASTE_YOUR_API_KEY',
  authDomain: 'PASTE_YOUR_PROJECT.firebaseapp.com',
  projectId: 'PASTE_YOUR_PROJECT_ID',
  storageBucket: 'PASTE_YOUR_PROJECT.firebasestorage.app',
  messagingSenderId: 'PASTE_YOUR_MESSAGING_SENDER_ID',
  appId: 'PASTE_YOUR_APP_ID'
};

// เปลี่ยนค่านี้เมื่อต้องการแยกข้อมูลของคนละร้านใน Firebase โปรเจกต์เดียวกัน
export const storeId = 'crazsix-store';
