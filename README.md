# Crazsix Store Workspace

เว็บจัดการสต็อกเสื้อผ้า การขาย และบัญชีร้าน Crazsix พร้อมหน้าตา Liquid Glass ที่รองรับเดสก์ท็อปและมือถือ

เว็บไซต์: https://crazsix-stock.web.app

## ฟีเจอร์

- ภาพรวมมูลค่าสต็อก เงินเข้า–ออก 6 เดือน สินค้าใกล้หมด สินค้ารอรับ และยอดค้างชำระ
- สินค้าหลายสี/ไซส์ แยกมือหนึ่ง–มือสอง รูปแยกตามสี เพิ่มหลายสินค้าและเติมสต็อกแบบต้นทุนเฉลี่ย
- ต้นทุนต่อชิ้น/เหมาล็อต สินค้าสั่งซื้อรอรับ และค่าส่งรวมหลายสินค้า
- ขายสินค้า พร้อมค่าส่ง ค่ากลาง กำไรประมาณ มัดจำ และการผ่อนชำระ
- รายรับ–รายจ่าย พร้อมค้นหา กรองประเภท/เดือน สถิติสินค้า และรายงานกำไร
- สำรอง/นำเข้า JSON รองรับข้อมูลเก่า รวมข้อมูลซ้ำ และล้างข้อมูลผ่านการยืนยัน
- วิเคราะห์แนวโน้มจากข้อมูลจริงด้วยกฎในเครื่อง บริการ AI ภายนอกยังไม่ได้เชื่อมต่อ จึงระบุไว้ชัดเจนในหน้าเว็บ

ข้อมูลเดิมอยู่ใน Firebase Firestore ที่ `stores/crazsix-store/data/{products,transactions,pendingOrders}` และยังใช้รูปแบบเดิม การดำเนินการที่เกี่ยวข้องกับหลายเอกสารบันทึกด้วย atomic batch ส่วนการอัปเดตสดจะไม่ล้างฟอร์มที่กำลังกรอก ข้อมูลยังเป็นอาร์เรย์ต่อเอกสารตามระบบเดิม จึงยังไม่ได้เพิ่มการแก้ความขัดแย้งเมื่อหลายเครื่องแก้รายการเดียวกันพร้อมกัน

## เปิดในเครื่อง

```bash
npm ci
npm run serve
```

เปิด http://127.0.0.1:4173 — เซิร์ฟเวอร์นี้ให้บริการหน้าแอปจริงซึ่งเชื่อมข้อมูล Firebase ตามค่าที่ตั้งไว้

## ทดสอบ

```bash
npx playwright install chromium
npm test
```

ชุดทดสอบแทนที่ Firebase ด้วยฐานข้อมูลจำลองก่อนโหลดแอป และบล็อกคำขอภายนอก จึงไม่แก้ข้อมูลร้านจริง ครอบคลุมสต็อก การขาย ผ่อนชำระ การบันทึกล้มเหลว สำรองข้อมูล วันที่กรุงเทพฯ และหน้าจอมือถือ

## Deploy

```bash
npx firebase-tools deploy --only hosting --project crazsix-stock
```

Firebase runs `npm run build` before each deployment. The build copies only the nine browser assets explicitly listed in `scripts/build.js` into `dist/`. Git metadata, tests, tools, packages, documentation and rules are never included. HTML, CSS and JavaScript revalidate their cached version on every request.

ตั้งค่า Firebase ที่ `js/firebase-config.js` และชั้นข้อมูลที่ `js/firebase-service.js` ดูการตั้งค่าเดิมเพิ่มเติมที่ [FIREBASE_SETUP.md](FIREBASE_SETUP.md)
