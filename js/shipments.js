// Delivery is independent of stock and payment: both are recorded at checkout.
import { money } from './preorders.js';
import { allocateCashCosts } from './inventory-tools.js';
export const deliveryLabels = {pending:'รอส่ง', partial:'ส่งบางส่วน', shipped:'ส่งสินค้าแล้ว', cancelled:'ยกเลิกการขายแล้ว'};
const sale = tx => tx && ['income','installment'].includes(tx.type) && ['ขายสินค้า','ขายสินค้ายกเลิก'].includes(tx.category);
const cash = n => Number.isFinite(n) && n>=0 && n<=1e12 && Math.abs(n-money(n))<1e-7;
// Receipts and refunds remain available for actual cash flow and refund reconciliation.
export const cancelledSaleFor = (tx, transactions) => tx.deliveryStatus === 'cancelled' ? tx : transactions.find(parent => parent.deliveryStatus === 'cancelled' && (parent.id === tx.installmentId || parent.id === tx.saleCancellationId));
export function activeAccountingTransactions(transactions) {
  const cancelledIds = new Set(transactions.filter(tx=>tx.deliveryStatus==='cancelled').map(tx=>tx.id));
  return transactions.filter(tx=>!cancelledIds.has(tx.id) && !cancelledIds.has(tx.installmentId) && !cancelledIds.has(tx.saleCancellationId));
}
export const cancellationRefundDue = tx => tx.type === 'installment' ? (tx.paidAmount || 0) : tx.amount;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const text = (value,max) => typeof value === 'string' && value.length <= max;
const validId = value => text(value,100) && value.length > 0 && !/[\s<>"'&]/.test(value);
export const trackedSale = tx => sale(tx) && Object.hasOwn(deliveryLabels,tx.deliveryStatus);
export const shippedQuantity = (saleId,shipments) => shipments.filter(s=>s.status === 'shipped').reduce((sum,s)=>sum+s.items.filter(i=>i.saleId === saleId).reduce((n,i)=>n+i.qty,0),0);
export function pendingDeliveries(transactions,shipments) {
  return transactions.filter(tx=>trackedSale(tx) && tx.deliveryStatus!=='cancelled').map(tx=>({sale:tx,shipped:shippedQuantity(tx.id,shipments)})).map(row=>({...row,remaining:row.sale.qty-row.shipped})).filter(row=>row.remaining>0);
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
    const expenses=transactions.filter(tx=>tx.shipmentId===s.id);
    if (s.shippingCost != null) {
      if (!cash(s.shippingCost) || s.items.some(i=>!cash(i?.shippingShare)) || money(s.items.reduce((sum,i)=>sum+i.shippingShare,0))!==s.shippingCost ||
        (s.shippingCost>0 ? expenses.length!==1 || expenses[0].amount!==s.shippingCost : expenses.length!==0)) return false;
    } else if (expenses.length || s.items.some(i=>!i || i.shippingShare!=null)) return false;
    for (const item of s.items) {
      const tx = transactions.find(tx=>tx.id === item?.saleId);
      if (!trackedSale(tx) || !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > tx.qty || s.date < tx.date) return false;
    }
  }
  return transactions.every(tx => {
    if(tx.shipmentId!=null) {
      const shipment=shipments.find(s=>s.id===tx.shipmentId);
      if(!shipment || tx.type!=='expense' || tx.category!=='ค่าส่ง' || tx.date!==shipment.date || !cash(tx.amount) || tx.amount<=0) return false;
    }
    if (tx.ledgerDeletedAt != null) {
      const parent = cancelledSaleFor(tx, transactions);
      if (!parent || !validDate(tx.ledgerDeletedAt) || tx.ledgerDeletedAt < parent.cancelledAt) return false;
    }
    if (tx.saleCancellationId != null) {
      const parent=transactions.find(t=>t.id===tx.saleCancellationId);
      if (!parent || parent.deliveryStatus!=='cancelled' || tx.type!=='expense' || tx.category!=='คืนเงินขายยกเลิก' || !cash(tx.amount) || tx.amount<=0 || tx.date<parent.cancelledAt) return false;
    }
    if (tx.deliveryStatus == null) return tx.category!=='ขายสินค้ายกเลิก';
    if (!trackedSale(tx) || !Number.isSafeInteger(tx.qty) || tx.qty<=0) return false;
    const parcelCost=money(shipments.reduce((sum,s)=>sum+s.items.filter(i=>i.saleId===tx.id).reduce((n,i)=>n+(i.shippingShare||0),0),0));
    if (parcelCost>0 && (!cash(tx.shipping) || parcelCost>tx.shipping || !Number.isFinite(tx.profit))) return false;
    if (tx.deliveryStatus==='cancelled') {
      const refunds=transactions.filter(t=>t.saleCancellationId===tx.id);
      const paid=tx.type==='installment' ? money(transactions.filter(t=>t.installmentId===tx.id && t.type==='income').reduce((sum,t)=>sum+t.amount,0)) : tx.amount;
      return tx.category==='ขายสินค้ายกเลิก' && shippedQuantity(tx.id,shipments)===0 && validDate(tx.cancelledAt) && tx.cancelledAt>=tx.date && text(tx.cancellationReason,500) &&
        cash(tx.refundDue) && tx.refundDue===cancellationRefundDue(tx) && paid===tx.refundDue && cash(tx.refundedAmount) && tx.refundedAmount<=tx.refundDue &&
        money(refunds.reduce((sum,t)=>sum+t.amount,0))===tx.refundedAmount;
    }
    return tx.category==='ขายสินค้า' && tx.cancelledAt==null && shippedQuantity(tx.id,shipments)<=tx.qty && tx.deliveryStatus===statusFor(tx,shipments);
  });
}
export function applyShipmentAction(state,action,id,today) {
  const transactions = structuredClone(state.transactions), shipments = structuredClone(state.shipments || []);
  const products = structuredClone(state.products);
  const check = (ok,message) => {if (!ok) throw new Error(message);};
  check(JSON.stringify(shipments) === action.expectedShipments, 'รายการจัดส่งเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดแล้วเลือกใหม่');
  const setShippingCost=(shipment,cost)=>{
    check(cash(cost), 'ค่าส่งต้องเป็นจำนวนตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง');
    const count=shipment.items.reduce((sum,i)=>sum+i.qty,0);
    const shares=allocateCashCosts(shipment.items.map(i=>cost*i.qty/count));
    shipment.items.forEach((item,index)=>{
      const tx=transactions.find(t=>t.id===item.saleId), delta=money(shares[index]-(item.shippingShare||0));
      check(trackedSale(tx),'ไม่พบรายการขายของพัสดุนี้');
      if(delta) {
        check(Number.isFinite(tx.profit) && cash(tx.shipping||0) && money((tx.shipping||0)+delta)>=0,'ข้อมูลกำไรหรือค่าส่งของรายการขายไม่ถูกต้อง');
        tx.shipping=money((tx.shipping||0)+delta);tx.profit=money(tx.profit-delta);
      }
      item.shippingShare=shares[index];
    });
    shipment.shippingCost=cost;
    const existing=transactions.findIndex(t=>t.shipmentId===shipment.id);
    if(existing>=0) transactions.splice(existing,1);
    if(cost>0) {
      const expenseId='shipment-cost-'+shipment.id;
      check(!transactions.some(t=>t.id===expenseId),'รหัสรายการค่าส่งซ้ำ กรุณาเปิดข้อมูลล่าสุด');
      transactions.unshift({id:expenseId,shipmentId:shipment.id,type:'expense',category:'ค่าส่ง',date:shipment.date,amount:cost,desc:`ค่าส่งพัสดุ ${shipment.trackingNumber || shipment.id} · ${shipment.items.length} รายการ`});
    }
  };
  let affected;
  if (['cancelSale','refundSale'].includes(action.type)) {
    const tx=transactions.find(t=>t.id===action.saleId);
    check(trackedSale(tx) && JSON.stringify(tx)===action.expectedSales?.[tx.id], 'รายการขายเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุด');
    if (action.type==='cancelSale') {
      check(tx.deliveryStatus==='pending' && shippedQuantity(tx.id,shipments)===0, 'ยกเลิกได้เฉพาะรายการที่ยังไม่ได้ส่งสินค้า');
      const variant=products.flatMap(p=>p.variants).find(v=>v.id===tx.productId);
      check(variant && Number.isFinite(tx.unitCost) && tx.unitCost>=0, 'ไม่พบตัวเลือกสินค้าหรือต้นทุนเดิมสำหรับคืนสต็อก กรุณาตรวจสอบสินค้า');
      check(Number.isSafeInteger(variant.qty) && variant.qty>=0 && Number.isSafeInteger(variant.qty+tx.qty), 'จำนวนสต็อกไม่ถูกต้อง ไม่สามารถคืนสินค้าได้');
      check(text(action.reason,500), 'เหตุผลยกเลิกต้องไม่เกิน 500 ตัวอักษร');
      variant.cost=(variant.cost*variant.qty+tx.unitCost*tx.qty)/(variant.qty+tx.qty);
      variant.qty+=tx.qty;
      tx.category='ขายสินค้ายกเลิก';tx.deliveryStatus='cancelled';tx.cancelledAt=today;tx.cancellationReason=action.reason;
      tx.refundDue=cancellationRefundDue(tx);tx.refundedAmount=0;
    } else {
      check(tx.deliveryStatus==='cancelled' && tx.refundDue>tx.refundedAmount, 'รายการนี้ไม่มีเงินรอคืนแล้ว');
      transactions.unshift({id,type:'expense',category:'คืนเงินขายยกเลิก',amount:money(tx.refundDue-tx.refundedAmount),date:today,desc:tx.desc,saleCancellationId:tx.id});
      tx.refundedAmount=tx.refundDue;
    }
    check(validateShipments(shipments,transactions), 'ข้อมูลยกเลิกหรือยอดรับชำระไม่ตรงกัน กรุณาตรวจสอบประวัติการรับเงิน');
    return {transactions,shipments,products};
  } else if (action.type === 'ship') {
    const data = action.values;
    check(validDate(data.date) && data.date <= today, 'วันที่ส่งสินค้าไม่ถูกต้องหรือเกินวันนี้');
    check(Array.isArray(data.items) && data.items.length > 0, 'เลือกสินค้าที่รอส่งอย่างน้อย 1 รายการ');
    check(new Set(data.items.map(i=>i.saleId)).size === data.items.length, 'พบรายการขายซ้ำในพัสดุ');
    for (const item of data.items) {
      const tx = transactions.find(t=>t.id === item.saleId);
      check(trackedSale(tx) && tx.deliveryStatus!=='cancelled' && JSON.stringify(tx) === action.expectedSales?.[item.saleId], 'รายการรอส่งเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุดแล้วเลือกใหม่');
      check(Number.isSafeInteger(item.qty) && item.qty > 0 && item.qty <= tx.qty-shippedQuantity(tx.id,shipments), 'จำนวนที่จะส่งต้องเป็นจำนวนเต็มและไม่เกินจำนวนรอส่ง');
      check(data.date >= tx.date, 'วันที่ส่งต้องไม่ก่อนวันที่ขายสินค้า');
    }
    shipments.unshift({id,status:'shipped',date:data.date,recipient:data.recipient,carrier:data.carrier,trackingNumber:data.trackingNumber,note:data.note,items:data.items.map(i=>({saleId:i.saleId,qty:i.qty}))});
    if(data.shippingCost != null && data.shippingCost!==0) setShippingCost(shipments[0],data.shippingCost);
    affected = data.items.map(i=>i.saleId);
  } else if(action.type==='shippingCost') {
    const shipment=shipments.find(s=>s.id===action.shipmentId);
    check(shipment && JSON.stringify(shipment)===action.expectedShipment,'ข้อมูลพัสดุเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุด');
    check(shipment.items.every(i=>JSON.stringify(transactions.find(t=>t.id===i.saleId))===action.expectedSales?.[i.saleId]),'รายการขายเปลี่ยนแปลง กรุณาเปิดข้อมูลล่าสุด');
    setShippingCost(shipment,action.amount);
    check(validateShipments(shipments,transactions),'ข้อมูลค่าส่งไม่ถูกต้อง');
    return {transactions,shipments,products};
  } else if (action.type === 'cancel') {
    const shipment = shipments.find(s=>s.id === action.shipmentId);
    check(shipment && shipment.status === 'shipped' && JSON.stringify(shipment) === action.expectedShipment, 'รายการส่งสินค้าเปลี่ยนแปลง กรุณาตรวจสอบอีกครั้ง');
    affected = shipment.items.map(i=>i.saleId);
    check(affected.every(id=>JSON.stringify(transactions.find(tx=>tx.id === id)) === action.expectedSales?.[id]), 'รายการขายเปลี่ยนแปลง กรุณาตรวจสอบอีกครั้ง');
    shipment.status = 'cancelled'; shipment.cancelledAt = today;
  } else throw new Error('ไม่รองรับการจัดส่งนี้');
  transactions.filter(tx=>affected.includes(tx.id)).forEach(tx=>{tx.deliveryStatus = statusFor(tx,shipments);});
  check(validateShipments(shipments,transactions), 'ข้อมูลการส่งสินค้าไม่ถูกต้อง กรุณาตรวจจำนวน วันที่ และข้อความ');
  return {transactions,shipments,products};
}
