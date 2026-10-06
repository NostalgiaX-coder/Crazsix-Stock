import { measurementsOf, measurementLabel } from "./inventory-tools.js";
// Customer orders are independent of the store's supplier pendingOrders.
export const preorderStatuses = {
  awaiting: "รับจองแล้ว",
  ordered: "สั่งให้ลูกค้าแล้ว",
  ready: "พร้อมส่งมอบ",
  completed: "ส่งมอบแล้ว",
  cancelled: "ยกเลิกแล้ว",
};
export const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
export const preorderTotal = (order) => money(order.qty * order.unitPrice);
export const preorderOpen = (order) => !["completed", "cancelled"].includes(order.status);
export const preorderBalance = (order) => order.status === "cancelled" ? 0 : money(preorderTotal(order) - order.paidAmount);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const amountValid = (value) => Number.isFinite(value) && value >= 0 && value <= 1e12 && Math.abs(value - money(value)) < 1e-7;
const textValid = (value, required = false) => typeof value === "string" && value.length <= 2000 && (!required || value.trim().length > 0);

export function validatePreorder(order, validDate) {
  return Boolean(order && textValid(order.id, true) &&
    ["customer", "name"].every(key => textValid(order[key], true)) &&
    ["contact", "color", "size", "note"].every(key => textValid(order[key])) &&
    ["new", "used"].includes(order.type) && Object.hasOwn(preorderStatuses, order.status) &&
    Number.isSafeInteger(order.qty) && order.qty > 0 &&
    (order.receivedQty == null || (Number.isSafeInteger(order.receivedQty) && order.receivedQty >= 0 && order.receivedQty <= order.qty)) &&
    (order.internationalShippingRecorded == null || (amountValid(order.internationalShippingRecorded) && order.internationalShippingRecorded <= (order.internationalShipping || 0))) &&
    (order.unitCost == null || amountValid(order.unitCost)) &&
    (order.internationalShipping == null || amountValid(order.internationalShipping)) &&
    amountValid(order.unitPrice) && order.unitPrice > 0 && amountValid(preorderTotal(order)) &&
    amountValid(order.paidAmount) && order.paidAmount <= preorderTotal(order) &&
    amountValid(order.refundedAmount) &&
    order.refundedAmount === (order.status === "cancelled" ? order.paidAmount : 0) &&
    (order.status !== "completed" || order.paidAmount === preorderTotal(order)) &&
    validDate(order.createdAt) && validDate(order.updatedAt) && (!order.dueDate || validDate(order.dueDate)));
}

export function preorderDetails(data, paidAmount, validDate) {
  const details = Object.fromEntries(["customer", "contact", "name", "color", "size", "note", "dueDate"].map(key => [key, String(data[key] || "").trim()]));
  const qty = Number(data.qty), unitPrice = Number(data.unitPrice);
  check(textValid(details.customer, true) && textValid(details.name, true), "กรุณาระบุชื่อลูกค้าและสินค้า (ไม่เกิน 2,000 ตัวอักษร)");
  check(Object.values(details).every(value => textValid(value)), "ข้อความยาวเกิน 2,000 ตัวอักษร");
  check(Number.isSafeInteger(qty) && qty > 0, "จำนวนต้องเป็นจำนวนเต็มมากกว่า 0");
  check(amountValid(unitPrice) && unitPrice > 0 && amountValid(money(qty * unitPrice)), "ราคาต้องมากกว่า 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง");
  check(amountValid(paidAmount) && paidAmount <= money(qty * unitPrice), "ยอดรับเงินต้องไม่เกินยอดสั่งซื้อ");
  check(!details.dueDate || validDate(details.dueDate), "วันนัดส่งไม่ถูกต้อง");
  check(["new", "used"].includes(data.type), "กรุณาระบุสภาพสินค้า");
  const unitCost = Number(data.unitCost || 0), internationalShipping = Number(data.internationalShipping || 0);
  check(amountValid(unitCost) && amountValid(money(unitCost * qty)) && amountValid(internationalShipping), "ต้นทุนและค่าขนส่งระหว่างประเทศต้องตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง");
  return { ...details, qty, unitPrice, unitCost, internationalShipping, type: data.type };
}

export function createPreorder(state, data, context) {
  const deposit = Number(data.deposit || 0);
  const details = preorderDetails(data, deposit, context.validDate);
  const order = { ...details, id: context.uid(), paidAmount: deposit, refundedAmount: 0, status: "awaiting", createdAt: context.today, updatedAt: context.today };
  state.preorders.unshift(order);
  if (deposit > 0) recordCash(state, order, deposit, "income", "มัดจำ pre-order", context);
  return order;
}

function recordCash(state, order, amount, type, category, context) {
  state.transactions.unshift({ id: context.uid(), type, category, amount, date: context.today, preorderId: order.id, desc: `${order.name} ×${order.qty} — ${order.customer}` });
}

export function updatePreorder(state, id, action, data, context) {
  const order = state.preorders.find(item => item.id === id);
  check(order && preorderOpen(order), "รายการนี้ปิดแล้ว หรือไม่พบรายการ กรุณาตรวจสอบข้อมูลล่าสุด");
  if (action === "edit") {
    const details = preorderDetails(data, order.paidAmount, context.validDate);
    check(details.qty >= (order.receivedQty || 0), "จำนวนสั่งต้องไม่น้อยกว่าจำนวนที่รับแล้ว");
    check(details.internationalShipping >= (order.internationalShippingRecorded || 0), "ค่าขนส่งต้องไม่น้อยกว่าส่วนแบ่งที่บันทึกจากล็อตแล้ว");
    if (order.receivedQty != null) order.status = order.receivedQty === details.qty ? "ready" : "ordered";
    Object.assign(order, details);
  } else if (action === "pay") {
    const amount = Number(data.amount);
    check(amountValid(amount) && amount > 0, "ระบุยอดรับเงินมากกว่า 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง");
    check(amount <= preorderBalance(order), "ยอดรับเงินเกินยอดค้างชำระ");
    order.paidAmount = money(order.paidAmount + amount);
    recordCash(state, order, amount, "income", "รับชำระ pre-order", context);
  } else if (action === "ordered") {
    check(["awaiting", "ordered"].includes(order.status) && !order.receivedQty, "รับของแล้ว ไม่สามารถเปลี่ยนการสั่งซื้อได้");
    order.status = data.checked ? "ordered" : "awaiting";
  } else if (action === "status") {
    const next = { awaiting: "ordered", ordered: "ready" }[order.status];
    check(next, "ไม่สามารถเปลี่ยนสถานะรายการนี้ได้");
    check(next !== "ready" || order.receivedQty == null || order.receivedQty === order.qty, "ยังรับของในล็อตไม่ครบ กรุณารับส่วนที่เหลือก่อน");
    order.status = next;
  } else if (action === "cancel") {
    if (order.paidAmount > 0) recordCash(state, order, order.paidAmount, "expense", "คืนเงิน pre-order", context);
    order.refundedAmount = order.paidAmount;
    order.status = "cancelled";
  } else if (action === "fulfill") {
    check(order.status === "ready", "กรุณาเปลี่ยนสถานะเป็นพร้อมส่งมอบก่อน");
    check(preorderBalance(order) === 0, "ต้องรับชำระครบก่อนส่งมอบสินค้า");
    const shipping = Number(data.shipping || 0), commission = Number(data.commission || 0);
    check(amountValid(shipping) && amountValid(commission), "ค่าส่งและค่ากลางต้องตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง");
    const internationalShipping = Number(data.internationalShipping ?? order.internationalShipping ?? 0);
    check(amountValid(internationalShipping) && internationalShipping >= (order.internationalShippingRecorded || 0), "ค่าขนส่งระหว่างประเทศต้องไม่น้อยกว่าส่วนแบ่งที่ลงบัญชีจากล็อตแล้ว");
    const shippingToRecord = money(internationalShipping - (order.internationalShippingRecorded || 0));
    let unitCost, variant;
    if (data.source === "stock") {
      variant = state.products.flatMap(product => product.variants).find(item => item.id === data.variantId);
      check(variant && variant.qty >= order.qty, "สต็อกไม่พอ หรือไม่พบสินค้าที่เลือก");
      unitCost = variant.cost;
      check(Number.isFinite(unitCost) && unitCost >= 0, "ต้นทุนสินค้าไม่ถูกต้อง");
    } else {
      check(data.source === "direct", "กรุณาเลือกวิธีส่งมอบ");
      unitCost = Number(data.unitCost);
      check(data.unitCost !== "" && amountValid(unitCost) && amountValid(money(unitCost * order.qty)), "กรุณาระบุต้นทุนต่อชิ้นให้ถูกต้อง");
    }
    // Validate everything before touching inventory or the ledger.
    if (variant) variant.qty -= order.qty;
    if (!variant && !data.costRecorded && unitCost > 0) recordCash(state, order, money(unitCost * order.qty), "expense", "ต้นทุน pre-order", context);
    if (shippingToRecord > 0) recordCash(state, order, shippingToRecord, "expense", "ค่าขนส่งระหว่างประเทศ pre-order", context);
    if (shipping > 0) recordCash(state, order, shipping, "expense", "ค่าส่ง pre-order", context);
    if (commission > 0) recordCash(state, order, commission, "expense", "ค่ากลาง pre-order", context);
    state.transactions.unshift({
      id: context.uid(), type: "preorder", category: "ขายสินค้า", preorderId: order.id,
      desc: `${order.name} ×${order.qty} — ${order.customer} (pre-order)${variant && measurementLabel(variant) ? " · " + measurementLabel(variant) : ""}`,
      date: context.today, amount: preorderTotal(order), qty: order.qty, unitPrice: order.unitPrice, productName: order.name,
      unitCost, shipping, commission, internationalShipping, deliveryStatus: "pending", customerNote: [order.customer, order.contact, order.note].filter(Boolean).join(" · "), productId: variant?.id || null,
      ...(variant ? measurementsOf(variant) : {}),
      ...(variant ? { stockProductId: state.products.find(p => p.variants.some(v => v.id === variant.id)).id } : {}),
      profit: money(preorderTotal(order) - unitCost * order.qty - shipping - commission - internationalShipping),
    });
    order.unitCost = unitCost;
    order.internationalShipping = internationalShipping;
    order.status = "completed";
    order.fulfilledAt = context.today;
    order.fulfillment = { source: data.source, variantId: variant?.id || null, unitCost, shipping, commission, internationalShipping, costRecorded: Boolean(data.costRecorded) };
  } else {
    throw new Error("ไม่รู้จักการดำเนินการนี้");
  }
  order.updatedAt = context.today;
}
