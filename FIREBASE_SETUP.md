# ตั้งค่า Firebase สำหรับ Crazsix Stock

## 1. สร้างโปรเจกต์และฐานข้อมูล

1. เข้า [Firebase Console](https://console.firebase.google.com/) แล้วสร้างโปรเจกต์
2. กด **Build > Firestore Database > Create database** และเลือกภูมิภาคใกล้ร้านที่สุด
3. ใน **Project settings > Your apps** เพิ่มแอปชนิด Web แล้วคัดลอกค่า config
4. วางค่าลงใน `js/firebase-config.js` ทุกช่องที่ขึ้นต้นด้วย `PASTE_YOUR_`
5. ในหน้า Firestore Rules ให้วางเนื้อหาจาก `firestore.rules` แล้ว Publish

## 2. โครงสร้างข้อมูล

ข้อมูลร้านอยู่ภายใต้ `stores/crazsix-store/data` และแยกเอกสารเป็น:

- `products` — สินค้าและตัวเลือกสี/ไซส์
- `transactions` — รายรับและรายจ่าย
- `pendingOrders` — ของที่สั่งแล้วและกำลังรอรับ

หากใช้ Firebase เดียวกันกับหลายร้าน ให้เปลี่ยน `storeId` ใน `js/firebase-config.js`

## 3. เปิดใน VS Code

เปิดโฟลเดอร์โปรเจกต์ใน VS Code แล้วเปิดผ่านส่วนขยาย **Live Server** (คลิกขวา `index.html` > Open with Live Server) หรือ deploy ด้วย Firebase Hosting. อย่าเปิดไฟล์ด้วย `file://` โดยตรง เพราะ Firebase module ต้องทำงานผ่านเว็บเซิร์ฟเวอร์

> Rules ที่ให้ไว้เปิดอ่าน/เขียนทุกคนเพื่อเริ่มทดสอบเท่านั้น ก่อนเผยแพร่เว็บไซต์จริง ควรเพิ่ม Firebase Authentication แล้วจำกัด Rules ให้ผู้ใช้ที่ล็อกอินเท่านั้น

> รูปสินค้ายังถูกเก็บไว้พร้อมข้อมูลสินค้า หากมีรูปจำนวนมาก ควรย้ายรูปไป Firebase Storage เพื่อหลีกเลี่ยงขีดจำกัดขนาดเอกสาร 1 MiB ของ Firestore
