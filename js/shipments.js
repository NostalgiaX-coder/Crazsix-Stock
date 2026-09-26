// Delivery is independent of stock and payment: both are recorded at checkout.
export const deliveryLabels = {pending:'รอส่ง', partial:'ส่งบางส่วน', shipped:'ส่งสินค้าแล้ว'};
const sale = tx => tx && ['income','installment'].includes(tx.type) && tx.category === 'ขายสินค้า';
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const text = (value,max) => typeof value === 'string' && value.length <= max;
const validId = value => text(value,100) && value.length > 0 && !/[\s<>"'&]/.test(value);
export const trackedSale = tx => sale(tx) && Object.hasOwn(deliveryLabels,tx.deliveryStatus);
export const shippedQuantity = (saleId,shipments) => shipments.filter(s=>s.status === 'shipped').reduce((sum,s)=>sum+s.items.filter(i=>i.saleId === saleId).reduce((n,i)=>n+i.qty,0),0);
export function pendingDeliveries(transactions,shipments) {
  return transactions.filter(trackedSale).map(tx=>({sale:tx,shipped:shippedQuantity(tx.id,shipments)})).map(row=>({...row,remaining:row.sale.qty-row.shipped})).filter(row=>row.remaining>0);
}
const statusFor = (tx,shipments) => {
  const sent = shippedQuantity(tx.id,shipments);
  return sent === 0 ? 'pending' : sent === tx.qty ? 'shipped' : 'partial';
};
export function validateShipments(shipments,transactions) {
  if (!Array.isArray(shipments) || new Set(shipments.map(s=>s?.id)).size !== shipments.length) return false;
  for (const s of shipments) {
    if (!s || !validId(s.id) || !['shipped','cancelled'].includes(s.status) || !validDate(s.date) ||
      !text(s.recipient,2000) || !text(s.carrier,80) || !text(s.trackingNumber,120) || !text(s.note,1000) ||
      (s.status === 'cancelled' ? !validDate(s.cancelledAt) || s.cancelledAt < s.date : s.cancelledAt != null) ||
      !Array.isArray(s.items) || !s.items.length || new Set(s.items.map(i=>i?.saleId)).size !== s.items.length) return false;
    for (const item of s.items) {
      const tx = transactions.find(tx=>tx.id === item?.saleId);
      if (!trackedSale(tx) || !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > tx.qty || s.date < tx.date) return false;
    }
  }
  return transactions.every(tx => tx.deliveryStatus == null || (trackedSale(tx) && Number.isSafeInteger(tx.qty) && tx.qty>0 &&
    shippedQuantity(tx.id,shipments) <= tx.qty && tx.deliveryStatus === statusFor(tx,shipments)));
}
export function applyShipmentAction(state,action,id,today) {
  const transactions = structuredClone(state.transactions), shipments = structuredClone(state.shipments || []);
  const check = (ok,message) => {if (!ok) throw new Error(message);};
  check(JSON.stringify(shipments) === action.expectedShipments, 'รายการจัดส่งเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดแล้วเลือกใหม่');
  let affected;
  if (action.type === 'ship') {
    const data = action.values;
    check(validDate(data.date) && data.date <= today, 'วันที่ส่งสินค้าไม่ถูกต้องหรือเกินวันนี้');
    check(Array.isArray(data.items) && data.items.length > 0, 'เลือกสินค้าที่รอส่งอย่างน้อย 1 รายการ');
    check(new Set(data.items.map(i=>i.saleId)).size === data.items.length, 'พบรายการขายซ้ำในพัสดุ');
    for (const item of data.items) {
      const tx = transactions.find(t=>t.id === item.saleId);
      check(trackedSale(tx) && JSON.stringify(tx) === action.expectedSales?.[item.saleId], 'รายการรอส่งเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดแล้วเลือกใหม่');
      check(Number.isSafeInteger(item.qty) && item.qty > 0 && item.qty <= tx.qty-shippedQuantity(tx.id,shipments), 'จำนวนที่จะส่งต้องเป็นจำนวนเต็มและไม่เกินจำนวนรอส่ง');
      check(data.date >= tx.date, 'วันที่ส่งต้องไม่ก่อนวันที่ขายสินค้า');
    }
    shipments.unshift({id,status:'shipped',date:data.date,recipient:data.recipient,carrier:data.carrier,trackingNumber:data.trackingNumber,note:data.note,items:data.items.map(i=>({saleId:i.saleId,qty:i.qty}))});
    affected = data.items.map(i=>i.saleId);
  } else if (action.type === 'cancel') {
    const shipment = shipments.find(s=>s.id === action.shipmentId);
    check(shipment && shipment.status === 'shipped' && JSON.stringify(shipment) === action.expectedShipment, 'รายการส่งสินค้าเปลี่ยนแปลง กรุณาตรวจสอบอีกครั้ง');
    affected = shipment.items.map(i=>i.saleId);
    check(affected.every(id=>JSON.stringify(transactions.find(tx=>tx.id === id)) === action.expectedSales?.[id]), 'รายการขายเปลี่ยนแปลง กรุณาตรวจสอบอีกครั้ง');
    shipment.status = 'cancelled'; shipment.cancelledAt = today;
  } else throw new Error('ไม่รองรับการจัดส่งนี้');
  transactions.filter(tx=>affected.includes(tx.id)).forEach(tx=>{tx.deliveryStatus = statusFor(tx,shipments);});
  check(validateShipments(shipments,transactions), 'ข้อมูลการส่งสินค้าไม่ถูกต้อง กรุณาตรวจจำนวน วันที่ และข้อความ');
  return {transactions,shipments};
}
