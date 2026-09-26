import { deliveryLabels, pendingDeliveries, validateShipments, applyShipmentAction } from "./shipments.js";
import { renderShipments, wireShipments } from "./shipments-ui.js";
import { campaignProductIds, campaignHasProduct, campaignUntilBudget, productAdMetrics, validateAdsBackup, validateAdWallet, applyAdAction, isAdSpend } from "./ads.js";
import { renderAds, wireAds } from "./ads-ui.js";
import { parseMeasurement, measurementsOf, validMeasurements, measurementLabel, stockOptionKey, assertStockRows, assertShipping, stockAdjustment, validAdjustments, allocateCashCosts } from "./inventory-tools.js";
import { toCsv, cashSummary, followUpItems } from "./store-tools.js";
import { stockDatabase, firebaseConfigured } from "./firebase-service.js";
import { money, preorderStatuses, preorderTotal, preorderOpen, preorderBalance, validatePreorder, createPreorder, updatePreorder } from "./preorders.js";

const STORE_PRODUCTS = "shop_products_v2";
const STORE_PRODUCTS_OLD = "shop_products_v1";
const STORE_TX = "shop_transactions_v1";
const STORE_PENDING = "shop_pending_v1";

let products = [];
let transactions = [];
let pendingOrders = [];
let preorders = [];
let adCampaigns = [];
let adWallet = [];
let shipments = [];
const STORE_NAMES = ["products", "transactions", "pendingOrders", "preorders", "adCampaigns", "adWallet", "shipments"];
let preorderSearch = "";
let preorderFilter = "open";
let activeTab = "home";
let loaded = false;
let loadError = false;
let stockSearch = "";
let editingVariantId = null;
let editingVariantSnapshot = null;
let aiResult = null;
let aiLoading = false;
let aiError = null;
let monthlyChartInstance = null;
let topChartInstance = null;
let shipmentDraft = { amount: "", date: "", rows: [{ variantId: "", qty: 1 }] };
const LOW_STOCK_THRESHOLD = 1;

const app = document.getElementById("app");
const fmtMoney = (n) =>
  "฿" + Number(n || 0).toLocaleString("th-TH", { maximumFractionDigits: 2 });
const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const normalizedText = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
const localDateStr = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const todayStr = () => localDateStr();
const monthKey = (d) => String(d || "").slice(0, 7);
const monthLabel = (key) => {
  const [y, m] = key.split("-");
  const names = [
    "ม.ค.",
    "ก.พ.",
    "มี.ค.",
    "เม.ย.",
    "พ.ค.",
    "มิ.ย.",
    "ก.ค.",
    "ส.ค.",
    "ก.ย.",
    "ต.ค.",
    "พ.ย.",
    "ธ.ค.",
  ];
  return names[parseInt(m, 10) - 1] + " " + (parseInt(y, 10) + 543);
};

// ---------- Custom modal (replaces native confirm/alert, which can be blocked) ----------
let modalResolve = null;
function showConfirm(message) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    document.getElementById("modal-message").textContent = message;
    document.getElementById("modal-cancel-btn").style.display = "inline-block";
    document.getElementById("modal-ok-btn").textContent = "ยืนยัน";
    document.getElementById("modal-overlay").classList.add("show");
  });
}
function showAlert(message) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    document.getElementById("modal-message").textContent = message;
    document.getElementById("modal-cancel-btn").style.display = "none";
    document.getElementById("modal-ok-btn").textContent = "ตกลง";
    document.getElementById("modal-overlay").classList.add("show");
  });
}
function closeModal(result) {
  document.getElementById("modal-overlay").classList.remove("show");
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}
document.getElementById("modal-ok-btn").onclick = () => closeModal(true);
document.getElementById("modal-cancel-btn").onclick = () => closeModal(false);
document.getElementById("modal-overlay").onclick = (e) => {
  if (e.target.id === "modal-overlay") closeModal(false);
};
document.getElementById("detail-close-btn").onclick = closeDetail;
document.getElementById("detail-overlay").onclick = (e) => {
  if (e.target.id === "detail-overlay") closeDetail();
};
document.getElementById("edit-cancel-btn").onclick = closeEdit;
wireToggleLabels(document.getElementById("edit-form"));
document.getElementById("edit-overlay").onclick = (e) => {
  if (e.target.id === "edit-overlay") closeEdit();
};

let payingTxId = null;
function openPaymentModal(txId) {
  const tx = transactions.find(
    (t) => t.id === txId && t.type === "installment",
  );
  if (!tx) return;
  payingTxId = txId;
  const remaining = tx.amount - (tx.paidAmount || 0);
  document.getElementById("payment-info").textContent =
    (tx.desc || "") + " — ค้างชำระ " + fmtMoney(remaining);
  document.getElementById("payment-amount").value = remaining.toFixed(2);
  document.getElementById("payment-overlay").classList.add("show");
}
function closePayment() {
  payingTxId = null;
  document.getElementById("payment-overlay").classList.remove("show");
}
document.getElementById("payment-cancel-btn").onclick = closePayment;
document.getElementById("payment-overlay").onclick = (e) => {
  if (e.target.id === "payment-overlay") closePayment();
};
document.getElementById("payment-submit-btn").onclick = async () => {
  if (!payingTxId) return;
  const amountVal = document.getElementById("payment-amount").value;
  const ok = await recordInstallmentPayment(payingTxId, amountVal);
  if (ok) closePayment();
};

// ---------- Load / migrate / save ----------
function migrateFlatProducts(raw) {
  // Old format: flat list of {id,name,color,size,type,cost,price,qty,image,createdAt}
  // New format: [{id,name,image,createdAt,variants:[{id,color,size,type,cost,price,qty,createdAt}]}]
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const map = Object.create(null);
  const order = [];
  raw.forEach((item) => {
    const key = (item.name || "").trim().toLowerCase();
    if (!map[key]) {
      map[key] = {
        id: uid(),
        name: (item.name || "").trim(),
        image: item.image || null,
        createdAt: item.createdAt || todayStr(),
        variants: [],
      };
      order.push(key);
    }
    if (!map[key].image && item.image) map[key].image = item.image;
    map[key].variants.push({
      id: item.id || uid(),
      color: item.color || "",
      size: item.size || "",
      type: item.type || "new",
      cost: Number(item.cost) || 0,
      price: Number(item.price) || 0,
      qty: Number(item.qty) || 0,
      createdAt: item.createdAt || todayStr(),
    });
  });
  return order.map((k) => map[k]);
}

let loadPromise = null;
let storeUnsubscribers = [];
let confirmedStore = {};
let savingStores = new Set();
let formDirty = false;
let realtimeRenderPending = false;
let realtimeRenderTimer = null;
const copyData = (value) => JSON.parse(JSON.stringify(value));
const storeValues = () => ({ products, transactions, pendingOrders, preorders, adCampaigns, adWallet, shipments });
function assignStore(name, value) {
  const list = Array.isArray(value) ? value : [];
  if (name === "products") products = list;
  if (name === "transactions") transactions = list;
  if (name === "pendingOrders") pendingOrders = list;
  if (name === "preorders") preorders = list;
  if (name === "adCampaigns") adCampaigns = list;
  if (name === "adWallet") adWallet = list;
  if (name === "shipments") shipments = list;
}
function markRenderComplete() {
  formDirty = false;
  realtimeRenderPending = false;
}
function flushRealtimeRender() {
  clearTimeout(realtimeRenderTimer);
  const focused =
    app.contains(document.activeElement) &&
    document.activeElement.matches(
      'input, select, textarea, [contenteditable="true"]',
    );
  const modalOpen = document.querySelector(".modal-overlay.show");
  if (
    !loaded ||
    !realtimeRenderPending ||
    formDirty ||
    focused ||
    modalOpen ||
    savingStores.size
  )
    return;
  realtimeRenderPending = false;
  render();
}
function requestRealtimeRender() {
  realtimeRenderPending = true;
  clearTimeout(realtimeRenderTimer);
  realtimeRenderTimer = setTimeout(flushRealtimeRender, 80);
}
["input", "change"].forEach((eventName) =>
  app.addEventListener(eventName, (event) => {
    if (
      event.target.closest(
        "form, .sell-card, #workspace-shipping, #workspace-pending",
      )
    )
      formDirty = true;
  }),
);
app.addEventListener("click", (event) => {
  if (event.target.closest("#pending-select-all")) formDirty = true;
});
app.addEventListener("focusout", () => {
  clearTimeout(realtimeRenderTimer);
  realtimeRenderTimer = setTimeout(flushRealtimeRender, 80);
});
app.addEventListener("reset", () => {
  formDirty = false;
  requestRealtimeRender();
});
const modalRenderObserver = new MutationObserver(() => {
  if (!realtimeRenderPending) return;
  clearTimeout(realtimeRenderTimer);
  realtimeRenderTimer = setTimeout(flushRealtimeRender, 80);
});
document.querySelectorAll(".modal-overlay").forEach((overlay) =>
  modalRenderObserver.observe(overlay, {
    attributes: true,
    attributeFilter: ["class"],
  }),
);
window.addEventListener("beforeunload", (event) => {
  if (!formDirty && !savingStores.size) return;
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason?.storageReported) event.preventDefault();
});
["click", "submit"].forEach((eventName) =>
  document.addEventListener(
    eventName,
    (event) => {
      if (
        !savingStores.size ||
        (eventName === "click" &&
          !event.target.closest('button, input[type="submit"]'))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  ),
);

async function loadAll() {
  if (loadPromise) return loadPromise;
  loadPromise = loadStoreData().finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}
async function loadStoreData() {
  if (!firebaseConfigured) {
    loadError = true;
    render();
    return;
  }
  loadError = false;
  try {
    const names = STORE_NAMES;
    const values = await Promise.all(
      names.map((name) => stockDatabase.get(name)),
    );
    names.forEach((name, index) => assignStore(name, values[index]));
    confirmedStore = copyData(storeValues());

    loaded = true;
    subscribeToStoreChanges();
  } catch (e) {
    loadError = true;
    console.error("load error", e);
  }
  render();
}

function subscribeToStoreChanges() {
  storeUnsubscribers.forEach((unsubscribe) => unsubscribe());
  storeUnsubscribers = STORE_NAMES.map(
    (name) =>
      stockDatabase.subscribe(
        name,
        (value) => {
          if (savingStores.has(name)) return;
          const list = Array.isArray(value) ? value : [];
          if (JSON.stringify(confirmedStore[name]) === JSON.stringify(list))
            return;
          assignStore(name, list);
          confirmedStore[name] = copyData(list);
          requestRealtimeRender();
        },
        (error) => {
          console.error("realtime subscription failed", name, error);
          showAlert(
            "การอัปเดตข้อมูลสดหยุดทำงาน กรุณารีเฟรชหน้าเพื่อเชื่อมต่ออีกครั้ง",
          );
        },
      ),
  );
}

async function saveData(...names) {
  const values = storeValues();
  const payload = Object.fromEntries(
    names.map((name) => [name, copyData(values[name])]),
  );
  const expected = Object.fromEntries(names.map(name => [name, copyData(confirmedStore[name] || [])]));
  names.forEach((name) => savingStores.add(name));
  app.setAttribute("aria-busy", "true");
  const syncStatus = document.querySelector(".sync-status");
  const syncMarkup = syncStatus?.innerHTML;
  if (syncStatus) syncStatus.textContent = "กำลังบันทึก…";
  try {
    await stockDatabase.setMany(payload, expected);
    names.forEach((name) => {
      confirmedStore[name] = copyData(payload[name]);
    });
    if (typeof toast === "function") toast("บันทึกข้อมูลเรียบร้อยแล้ว");
  } catch (error) {
    names.forEach((name) =>
      assignStore(name, copyData(confirmedStore[name] || [])),
    );
    if (error.code === "store/conflict") {
      // Keep form controls intact; only refresh the underlying data for retry.
      const latest = await Promise.allSettled(names.map(name => stockDatabase.get(name)));
      latest.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const name = names[index];
        assignStore(name, result.value);
        confirmedStore[name] = copyData(storeValues()[name]);
      });
      requestRealtimeRender();
    }
    console.error("save failed", error);
    error.storageReported = true;
    showAlert(
      error.code === "store/conflict"
        ? "มีการเปลี่ยนข้อมูลจากอุปกรณ์อื่น รายการนี้ยังไม่ถูกบันทึก กรุณาเปิดหน้ารายการใหม่เพื่อตรวจสอบข้อมูลล่าสุดแล้วลองอีกครั้ง"
        : "บันทึกไม่สำเร็จ ข้อมูลยังไม่ได้เปลี่ยนแปลง กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง",
    );
    throw error;
  } finally {
    names.forEach((name) => savingStores.delete(name));
    app.setAttribute("aria-busy", "false");
    if (syncStatus && syncMarkup != null) syncStatus.innerHTML = syncMarkup;
  }
}
const saveProducts = () => saveData("products");
const saveTx = () => saveData("transactions");
const savePending = () => saveData("pendingOrders");

// ---------- Backup export / import ----------
function exportData() {
  const payload = {
    exportedAt: new Date().toISOString(),
    version: 10,
    products,
    transactions,
    pendingOrders,
    preorders,
    adCampaigns,
    adWallet,
    shipments,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "crazsix-store-backup-" + todayStr() + ".json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function validCash(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1e12 && Math.abs(value - money(value)) < 1e-7;
}
function validDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T12:00:00");
  return !Number.isNaN(date.getTime()) && localDateStr(date) === value;
}
function validInventoryRow(row) {
  return (
    row &&
    typeof row.id === "string" &&
    row.id &&
    ["new", "used"].includes(row.type) &&
    (row.color == null || typeof row.color === "string") &&
    (row.size == null || typeof row.size === "string") &&
    Number.isInteger(row.qty) &&
    row.qty >= 0 &&
    Number.isFinite(row.cost) &&
    row.cost >= 0 &&
    Number.isFinite(row.price) &&
    row.price >= 0 &&
    validMeasurements(row) && validAdjustments(row.adjustments)
  );
}
function validateBackup(data) {
  if (
    !data ||
    !Array.isArray(data.products) ||
    !Array.isArray(data.transactions)
  )
    throw new Error("รูปแบบไฟล์สำรองไม่ถูกต้อง");
  const isLegacy =
    data.products.length &&
    data.products.every(
      (row) =>
        row && !Object.hasOwn(row, "variants") && Object.hasOwn(row, "qty"),
    );
  const importedProducts = isLegacy
    ? migrateFlatProducts(data.products)
    : data.products;
  const importedPending = data.pendingOrders == null ? [] : data.pendingOrders;
  const validProducts = importedProducts.every(
    (product) =>
      product &&
      typeof product.id === "string" &&
      typeof product.name === "string" &&
      product.name.trim() &&
      Array.isArray(product.variants) &&
      product.variants.every(validInventoryRow),
  );
  const validTransactions = data.transactions.every(
    (tx) =>
      tx &&
      typeof tx.id === "string" &&
      ["income", "expense", "installment", "preorder"].includes(tx.type) &&
      Number.isFinite(tx.amount) &&
      tx.amount >= 0 &&
      validDateString(tx.date) && validMeasurements(tx) &&
      (tx.dueDate == null || validDateString(tx.dueDate)) &&
      (tx.paidAmount == null ||
        (Number.isFinite(tx.paidAmount) && tx.paidAmount >= 0 && tx.paidAmount <= tx.amount)),
  );
  const validPending =
    Array.isArray(importedPending) &&
    importedPending.every(
      (row) =>
        validInventoryRow(row) &&
        typeof row.name === "string" &&
        row.name.trim() &&
        validDateString(row.orderDate),
    );
  const importedPreorders = data.preorders == null ? [] : data.preorders;
  const uniqueIds = rows => rows.every(row => row && typeof row.id === "string" && row.id.trim() && !/[\s<>"\'&]/.test(row.id)) && new Set(rows.map(row => row.id)).size === rows.length;
  const validPreorders = Array.isArray(importedPreorders) && importedPreorders.every(row => validatePreorder(row, validDateString));
  if (!validProducts || !validTransactions || !validPending || !validPreorders)
    throw new Error("พบรายการสินค้า จำนวนเงิน หรือวันที่ไม่ถูกต้องในไฟล์สำรอง");
  const groups = [importedProducts, importedProducts.flatMap(product => product.variants), data.transactions, importedPending, importedPreorders];
  if (!groups.every(uniqueIds)) throw new Error("พบรหัสรายการซ้ำ ว่าง หรือมีอักขระที่ไม่รองรับในไฟล์สำรอง");
  const productIds = new Set(importedProducts.map(product => product.id));
  if (importedPending.some(order => order.productId != null && !productIds.has(order.productId))) throw new Error("รายการรอรับอ้างถึงสินค้าที่ไม่มีในไฟล์สำรอง");
  const preorderIds = new Set(importedPreorders.map(order => order.id));
  if (data.transactions.some(tx => (tx.preorderId && !preorderIds.has(tx.preorderId)) || (tx.type === "preorder" && !tx.preorderId)))
    throw new Error("รายการบัญชี pre-order ไม่มีคำสั่งซื้อที่ตรงกัน");
  for (const order of importedPreorders) {
    const ledger = data.transactions.filter(tx => tx.preorderId === order.id);
    const paid = ledger.filter(tx => tx.type === "income").reduce((sum, tx) => sum + tx.amount, 0);
    const refunds = ledger.filter(tx => tx.category === "คืนเงิน pre-order").reduce((sum, tx) => sum + tx.amount, 0);
    const sales = ledger.filter(tx => tx.type === "preorder");
    if (Math.abs(paid - order.paidAmount) > 0.001 || Math.abs(refunds - order.refundedAmount) > 0.001 ||
        sales.length !== (order.status === "completed" ? 1 : 0) ||
        sales.some(tx => tx.amount !== preorderTotal(order) || tx.qty !== order.qty || !Number.isFinite(tx.profit)))
      throw new Error("ยอดเงินหรือสถานะ pre-order ไม่ตรงกับบัญชีในไฟล์สำรอง");
  }
  const importedAds = data.adCampaigns ?? [];
  const importedWallet = data.adWallet ?? [];
  const importedShipments = data.shipments ?? [];
  if (!validateShipments(importedShipments, data.transactions)) throw new Error("ข้อมูลการจัดส่งหรือสถานะรายการขายไม่ถูกต้อง");
  if (!validateAdWallet(importedWallet, importedAds)) throw new Error("ข้อมูลยอดเติมเงิน Ads Manager ไม่ถูกต้อง");
  if (!validateAdsBackup(importedAds, data.transactions, importedProducts)) throw new Error("ข้อมูลแคมเปญโฆษณาหรือรายการบัญชีที่ผูกไม่ถูกต้อง");
  return {
    adCampaigns: importedAds,
    adWallet: importedWallet,
    shipments: importedShipments,
    preorders: importedPreorders,
    products: importedProducts,
    transactions: data.transactions,
    pendingOrders: importedPending,
  };
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = validateBackup(JSON.parse(text));
    if (
      !(await showConfirm(
        "นำเข้าข้อมูลนี้จะเขียนทับข้อมูลปัจจุบันทั้งหมด ต้องการดำเนินการต่อหรือไม่?",
      ))
    ) {
      e.target.value = "";
      return;
    }
    products = data.products;
    transactions = data.transactions;
    pendingOrders = data.pendingOrders;
    preorders = data.preorders;
    adCampaigns = data.adCampaigns;
    adWallet = data.adWallet;
    shipments = data.shipments;
    await saveData(...STORE_NAMES);
    e.target.value = "";
    render();
  } catch (err) {
    console.error("import failed", err);
    if (!err.storageReported)
      showAlert(
        "นำเข้าข้อมูลไม่สำเร็จ: " +
          (err.message || "ไฟล์อาจเสียหายหรือไม่ถูกต้อง"),
      );
    e.target.value = "";
  }
}

// ---------- Data helpers ----------
function allVariants() {
  const list = [];
  products.forEach((prod) =>
    prod.variants.forEach((v) => list.push({ product: prod, variant: v })),
  );
  return list;
}
function stockColorGroups() {
  const groups = new Map();
  allVariants().forEach(({ product, variant }) => {
    const key =
      normalizedText(product.name) + "|" + normalizedText(variant.color);
    if (!groups.has(key))
      groups.set(key, {
        name: product.name,
        color: variant.color || "-",
        image: productColorImage(product, variant.color),
        variants: [],
      });
    const group = groups.get(key);
    group.variants.push({ product, variant });
  });
  return [...groups.values()];
}
function saleProductGroups() {
  const groups = new Map();
  allVariants()
    .filter(({ variant }) => variant.qty > 0)
    .forEach(({ product, variant }) => {
      const key = normalizedText(product.name);
      if (!groups.has(key))
        groups.set(key, {
          name: product.name,
          image: productColorImage(product, variant.color),
          variants: [],
        });
      const group = groups.get(key);
      group.variants.push({ product, variant });
    });
  return [...groups.values()];
}
function compareSizes(a, b) {
  const order = ["xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "4xl", "5xl"];
  const left = normalizedText(a);
  const right = normalizedText(b);
  if (!left || !right) return !left && !right ? 0 : !left ? 1 : -1;
  const leftRank = order.indexOf(left);
  const rightRank = order.indexOf(right);
  if (leftRank !== -1 || rightRank !== -1) {
    return (
      (leftRank === -1 ? 999 : leftRank) - (rightRank === -1 ? 999 : rightRank)
    );
  }
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber))
    return leftNumber - rightNumber;
  return String(a || "").localeCompare(String(b || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
function findVariant(variantId) {
  for (const prod of products) {
    const v = prod.variants.find((x) => x.id === variantId);
    if (v) return { product: prod, variant: v };
  }
  return null;
}
function variantLabel(product, variant) {
  const parts = [product.name];
  if (variant.color) parts.push(variant.color);
  if (variant.size) parts.push("ไซส์ " + variant.size);
  parts.push(variant.type === "used" ? "มือ2" : "มือ1");
  if (measurementLabel(variant)) parts.push(measurementLabel(variant));
  return parts.join(" · ");
}
function productColorImage(product, color) {
  const key = normalizedText(color);
  if (product.colorImages && product.colorImages[key])
    return product.colorImages[key];
  return product.image || null;
}
function setProductColorImage(prod, color, image) {
  if (!image) return;
  prod.colorImages = prod.colorImages || {};
  prod.colorImages[normalizedText(color)] = image;
  if (!prod.image) prod.image = image;
}
function stockValue() {
  return allVariants().reduce(
    (s, { variant }) => s + variant.cost * variant.qty,
    0,
  );
}
function lowStockVariants() {
  return allVariants().filter(
    ({ variant }) =>
      variant.type === "new" &&
      variant.qty > 0 &&
      variant.qty <= LOW_STOCK_THRESHOLD,
  );
}
function txForMonth(key) {
  return transactions.filter((t) => monthKey(t.date) === key);
}
function monthSummary(key) {
  const list = txForMonth(key);
  const income = list
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount, 0);
  const expense = list
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + t.amount, 0);
  return { income, expense, profit: income - expense };
}
function variantStats(variantId) {
  const sales = transactions.filter(
    (t) =>
      t.productId === variantId &&
      t.category === "ขายสินค้า" &&
      t.profit != null,
  );
  return summarizeSales(sales);
}
function productAggregateStats(productId) {
  const prod = products.find((p) => p.id === productId);
  if (!prod) return summarizeSales([]);
  const ids = prod.variants.map((v) => v.id);
  const sales = transactions.filter(
    (t) =>
      ids.includes(t.productId) &&
      t.category === "ขายสินค้า" &&
      t.profit != null,
  );
  return summarizeSales(sales);
}
function summarizeSales(sales) {
  const totalQtySold = sales.reduce((s, t) => s + (t.qty || 0), 0);
  const totalProfit = sales.reduce((s, t) => s + (t.profit || 0), 0);
  const byMonth = {};
  sales.forEach((t) => {
    const k = monthKey(t.date);
    if (!byMonth[k]) byMonth[k] = { qty: 0, profit: 0 };
    byMonth[k].qty += t.qty || 0;
    byMonth[k].profit += t.profit || 0;
  });
  const months = Object.keys(byMonth)
    .sort()
    .reverse()
    .map((k) => ({ key: k, ...byMonth[k] }));
  return { totalQtySold, totalProfit, months };
}
function topSellers(limit, sortBy) {
  const map = new Map();
  transactions.filter(tx => tx.category === "ขายสินค้า" && tx.profit != null).forEach(tx => {
    const product = findVariant(tx.productId)?.product;
    const key = product?.id || tx.productName || tx.productId || tx.desc;
    const item = map.get(key) || { name: product?.name || tx.productName || tx.desc || "สินค้าที่นำออกจากสต็อก", qty: 0, profit: 0 };
    item.qty += tx.qty || 0;
    item.profit += tx.profit || 0;
    map.set(key, item);
  });
  return [...map.values()]
    .sort((a, b) => (sortBy === "profit" ? b.profit - a.profit : b.qty - a.qty))
    .slice(0, limit);
}
function last6MonthsKeys() {
  const arr = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    arr.push(localDateStr(d).slice(0, 7));
  }
  return arr;
}

// ---------- Actions ----------
function addVariantCore(data) {
  const key = normalizedText(data.name);
  let prod = data.productId ? products.find(p => p.id === data.productId) : products.find((p) => normalizedText(p.name) === key);
  const color = (data.color || "").trim();
  const size = (data.size || "").trim();
  const type = data.type;

  if (prod) {
    // Actual measurements distinguish items even when their tag size matches.
    const existing = prod.variants.find(v => stockOptionKey(v) === stockOptionKey(data));
    if (existing) {
      // เจอตัวเลือกเดิม -> บวกจำนวนเข้าไป และเฉลี่ยต้นทุนถ่วงน้ำหนัก
      const totalOldValue = existing.qty * existing.cost;
      const totalNewValue = data.qty * data.cost;
      const newQty = existing.qty + data.qty;
      existing.cost =
        newQty > 0 ? (totalOldValue + totalNewValue) / newQty : data.cost;
      existing.qty = newQty;
      existing.price = data.price;
      setProductColorImage(prod, color, data.image);
      return { prod, variant: existing };
    }
    // ไม่เจอตัวเลือกเดิม -> สร้างตัวเลือกใหม่ตามปกติ
    const variant = {
      id: uid(),
      color,
      size,
      type,
      ...measurementsOf(data),
      cost: data.cost,
      price: data.price,
      qty: data.qty,
      createdAt: todayStr(),
    };
    prod.variants.unshift(variant);
    setProductColorImage(prod, color, data.image);
    return { prod, variant };
  } else {
    const variant = {
      id: uid(),
      color,
      size,
      type,
      ...measurementsOf(data),
      cost: data.cost,
      price: data.price,
      qty: data.qty,
      createdAt: todayStr(),
    };
    prod = {
      id: uid(),
      name: data.name.trim(),
      image: null,
      colorImages: {},
      createdAt: todayStr(),
      variants: [variant],
    };
    setProductColorImage(prod, color, data.image);
    products.unshift(prod);
    return { prod, variant };
  }
}

async function addProductOrVariant(data) {
  assertStockRows([data]);
  assertShipping(Number(data.shippingIn || 0));
  const { prod, variant } = addVariantCore(data);
  let txAdded = false;
  if (data.logExpense && data.cost * data.qty > 0) {
    transactions.unshift({
      id: uid(),
      type: "expense",
      category: "ซื้อสินค้าเข้าสต็อก",
      desc: variantLabel(prod, variant),
      amount: data.cost * data.qty,
      date: todayStr(),
      productId: variant.id,
    });
    txAdded = true;
  }
  const shippingIn = parseFloat(data.shippingIn) || 0;
  if (shippingIn > 0) {
    transactions.unshift({
      id: uid(),
      type: "expense",
      category: "ค่าส่งสินค้าเข้า",
      desc: variantLabel(prod, variant) + " (ค่าส่งจากต้นทาง)",
      amount: shippingIn,
      date: todayStr(),
      productId: variant.id,
    });
    txAdded = true;
  }
  await saveData("products", ...(txAdded ? ["transactions"] : []));
  render();
}

// rows: [{name,color,size,type,price,cost,qty,image}]; base: {logExpense, shippingIn}
async function addProductBatch(base, rows) {
  assertStockRows(rows);
  assertShipping(Number(base.shippingIn || 0));
  const created = rows.map((r) => ({
    ...addVariantCore({
      ...measurementsOf(r),
      name: r.name,
      color: r.color,
      size: r.size,
      type: r.type,
      cost: r.cost,
      price: r.price,
      qty: r.qty,
      image: r.image,
    }),
    addedQty: r.qty,
    batchCost: r.cost,
  }));
  let txAdded = false;
  if (base.logExpense) {
    const costs = allocateCashCosts(created.map(item => item.batchCost * item.addedQty));
    created.forEach(({ prod, variant, addedQty, batchCost }, index) => {
      if (costs[index] > 0) {
        transactions.unshift({
          id: uid(),
          type: "expense",
          category: "ซื้อสินค้าเข้าสต็อก",
          desc: variantLabel(prod, variant),
          amount: costs[index],
          date: todayStr(),
          productId: variant.id,
        });
        txAdded = true;
      }
    });
  }
  const shippingIn = parseFloat(base.shippingIn) || 0;
  if (shippingIn > 0) {
    const desc = created
      .map(({ prod, variant }) => variantLabel(prod, variant))
      .join(", ");
    transactions.unshift({
      id: uid(),
      type: "expense",
      category: "ค่าส่งสินค้าเข้า",
      desc: desc + " (ค่าส่งจากต้นทาง)",
      amount: shippingIn,
      date: todayStr(),
      productId: null,
    });
    txAdded = true;
  }
  await saveData("products", ...(txAdded ? ["transactions"] : []));
  render();
}

async function attachShippingBulk(items, amount, date) {
  if (!validCash(amount) || amount <= 0 || (date && !validDateString(date)) || !items.length ||
      items.some(item => !Number.isSafeInteger(item.qty) || item.qty < 1 || !findVariant(item.variantId) || item.qty > findVariant(item.variantId).variant.qty)) {
    showAlert("กรุณาตรวจจำนวนสินค้า ยอดค่าส่ง และวันที่ จำนวนแนบต้องไม่เกินสต็อกปัจจุบัน");
    return;
  }
  const labels = items.map((it) => it.label + " x" + it.qty);
  transactions.unshift({
    id: uid(),
    type: "expense",
    category: "ค่าส่งสินค้าเข้า (เหมาล็อต)",
    desc: labels.join(", "),
    amount,
    date: date || todayStr(),
    items: items.map((it) => ({ productId: it.variantId, qty: it.qty })),
  });
  await saveTx();
  render();
}

function duplicateMergePreview() {
  const variants = allVariants();
  const productKeys = new Set(products.map((p) => normalizedText(p.name)));
  const variantKeys = new Set(
    variants.map(
      ({ product, variant }) =>
        JSON.stringify([normalizedText(product.name), stockOptionKey(variant)]),
    ),
  );
  return {
    duplicateProducts: products.length - productKeys.size,
    duplicateVariants: variants.length - variantKeys.size,
  };
}

async function mergeDuplicateData() {
  const mergedProducts = new Map();
  const idMap = new Map();
  const productIdMap = new Map();
  let mergedVariants = 0;
  products.forEach((product) => {
    const productKey = normalizedText(product.name);
    if (!mergedProducts.has(productKey))
      mergedProducts.set(productKey, {
        id: product.id,
        name: product.name.trim(),
        image: product.image || null,
        colorImages: {},
        createdAt: product.createdAt || todayStr(),
        variants: [],
      });
    const target = mergedProducts.get(productKey);
    productIdMap.set(product.id, target.id);
    if (!target.image && product.image) target.image = product.image;
    Object.assign(target.colorImages, product.colorImages || {});
    product.variants.forEach((source) => {
      const variantKey = stockOptionKey(source);
      let targetVariant = target.variants.find(
        (v) => v._mergeKey === variantKey,
      );
      if (!targetVariant) {
        targetVariant = { ...source, _mergeKey: variantKey };
        target.variants.push(targetVariant);
        return;
      }
      const oldQty = Number(targetVariant.qty) || 0;
      const addQty = Number(source.qty) || 0;
      const totalQty = oldQty + addQty;
      const oldValue = oldQty * (Number(targetVariant.cost) || 0);
      const addValue = addQty * (Number(source.cost) || 0);
      targetVariant.cost =
        totalQty > 0
          ? (oldValue + addValue) / totalQty
          : Math.max(Number(targetVariant.cost) || 0, Number(source.cost) || 0);
      targetVariant.qty = totalQty;
      if (source.adjustments?.length) targetVariant.adjustments = [...(targetVariant.adjustments || []), ...source.adjustments].sort((a, b) => a.date.localeCompare(b.date));
      if (source.price != null) targetVariant.price = Number(source.price) || 0;
      idMap.set(source.id, targetVariant.id);
      mergedVariants++;
    });
  });
  if (mergedVariants === 0 && mergedProducts.size === products.length)
    return null;
  products = [...mergedProducts.values()].map((product) => ({
    ...product,
    variants: product.variants.map(({ _mergeKey, ...variant }) => variant),
  }));
  transactions = transactions.map((tx) => ({
    ...tx,
    ...(tx.stockProductId ? { stockProductId: productIdMap.get(tx.stockProductId) || tx.stockProductId } : {}),
    ...(tx.productId !== undefined
      ? { productId: idMap.get(tx.productId) || tx.productId }
      : {}),
    ...(Array.isArray(tx.items)
      ? {
          items: tx.items.map((item) => ({
            ...item,
            ...(item.productId !== undefined
              ? { productId: idMap.get(item.productId) || item.productId }
              : {}),
          })),
        }
      : {}),
  }));
  preorders = preorders.map(order => order.fulfillment?.variantId && idMap.has(order.fulfillment.variantId)
    ? { ...order, fulfillment: { ...order.fulfillment, variantId: idMap.get(order.fulfillment.variantId) } } : order);
  pendingOrders = pendingOrders.map(order => order.productId ? { ...order, productId: productIdMap.get(order.productId) || order.productId } : order);
  adCampaigns = adCampaigns.map(c => {
    const productIds = [...new Set(campaignProductIds(c).map(id => productIdMap.get(id) || id))];
    return {...c, productId: productIds[0], productIds};
  });
  transactions.forEach(tx => {
    if (!tx.adAllocations) return;
    const shares = new Map();
    tx.adAllocations.forEach(a => { const id = productIdMap.get(a.productId) || a.productId; shares.set(id, money((shares.get(id) || 0) + a.amount)); });
    tx.adAllocations = [...shares].map(([productId,amount]) => ({productId,amount}));
  });
  await saveData("products", "transactions", "preorders", "pendingOrders", "adCampaigns");
  render();
  return mergedVariants;
}

// ---------- Pending orders (paid for, not yet physically received) ----------
function pendingLabel(po) {
  const parts = [po.name];
  if (po.color) parts.push(po.color);
  if (po.size) parts.push("ไซส์ " + po.size);
  parts.push(po.type === "used" ? "มือ2" : "มือ1");
  if (measurementLabel(po)) parts.push(measurementLabel(po));
  return parts.join(" · ");
}

function addPendingOrderCore(data) {
  const po = {
    id: uid(),
    name: data.name,
    color: data.color,
    size: data.size,
    ...measurementsOf(data),
    type: data.type,
    cost: data.cost,
    price: data.price,
    qty: data.qty,
    image: data.image || null,
    orderDate: todayStr(),
    ...(data.productId ? { productId: data.productId } : {}),
    note: (data.note || "").trim(),
  };
  pendingOrders.unshift(po);
  return po;
}

// rows: [{name,color,size,type,qty,cost,price}]; note: shared order note for all rows
async function addPendingOrderBatch(rows, note) {
  assertStockRows(rows);
  const created = rows.map((r) => addPendingOrderCore({ ...r, note }));
  const totalCost = money(created.reduce((s, po) => s + po.cost * po.qty, 0));
  if (totalCost > 0) {
    const desc = created
      .map((po) => pendingLabel(po) + " x" + po.qty)
      .join(", ");
    transactions.unshift({
      id: uid(),
      type: "expense",
      category: "สั่งซื้อสินค้า (รอของมาส่ง)",
      desc,
      amount: totalCost,
      date: todayStr(),
      pendingIds: created.map((po) => po.id),
    });
  }
  await saveData("pendingOrders", ...(rows.some(row => row.productId) ? ["products"] : []), ...(totalCost > 0 ? ["transactions"] : []));
  render();
}

async function receivePendingOrder(pendingId, shippingPaid) {
  return receivePendingOrdersBulk([pendingId], shippingPaid);
}
async function receivePendingOrdersBulk(ids, shippingTotal, quantities = {}) {
  const shipAmt = Number(shippingTotal || 0);
  const selected = [...new Set(ids)].map(id => pendingOrders.find(order => order.id === id));
  if (!Number.isFinite(shipAmt) || shipAmt < 0 || Math.abs(shipAmt - money(shipAmt)) > 1e-7) {
    showAlert("ค่าส่งต้องตั้งแต่ 0 และมีทศนิยมไม่เกิน 2 ตำแหน่ง");
    return;
  }
  if (!selected.length || selected.some(order => !order || !Number.isSafeInteger(Number(quantities[order.id] ?? order.qty)) || Number(quantities[order.id] ?? order.qty) < 1 || Number(quantities[order.id] ?? order.qty) > order.qty)) {
    showAlert("จำนวนรับต้องเป็นจำนวนเต็มตั้งแต่ 1 และไม่เกินจำนวนที่รอรับ กรุณาตรวจรายการล่าสุด");
    return;
  }
  if (selected.some(po => po.productId && !products.some(p => p.id === po.productId))) {
    showAlert("สินค้าเดิมของรายการรอรับถูกลบ กรุณากู้คืนสินค้าจากไฟล์สำรองก่อนรับของ");
    return;
  }
  const receivedItems = selected.map(po => {
    const qty = Number(quantities[po.id] ?? po.qty);
    const { prod, variant } = addVariantCore({ ...po, name: products.find(p => p.id === po.productId)?.name || po.name, qty });
    po.originalQty = po.originalQty ?? po.qty;
    po.receivedQty = (po.receivedQty || 0) + qty;
    po.qty -= qty;
    return { prod, variant, qty };
  });
  pendingOrders = pendingOrders.filter(order => order.qty > 0);
  if (shipAmt > 0) {
    transactions.unshift({
      id: uid(), type: "expense", category: "ค่าส่งสินค้าเข้า",
      desc: receivedItems.map(({ prod, variant, qty }) => variantLabel(prod, variant) + " x" + qty).join(", ") + " (ค่าส่งตอนรับของ)",
      amount: shipAmt, date: todayStr(), productId: null,
    });
  }
  await saveData("products", "pendingOrders", ...(shipAmt > 0 ? ["transactions"] : []));
  render();
}

async function deletePendingOrder(pendingId) {
  const reviewed = JSON.stringify(pendingOrders.find(order => order.id === pendingId));
  if (!reviewed) return;
  if (
    !(await showConfirm(
      "ยกเลิกรายการสั่งซื้อนี้? (ยอดที่จ่ายไปแล้วจะยังอยู่ในบัญชีรายจ่าย ไม่ถูกลบ)",
    ))
  )
    return;
  if (reviewed !== JSON.stringify(pendingOrders.find(order => order.id === pendingId))) {
    showAlert("รายการรอรับเปลี่ยนแปลงระหว่างยืนยัน กรุณาตรวจสอบอีกครั้ง");
    return;
  }
  pendingOrders = pendingOrders.filter((p) => p.id !== pendingId);
  await savePending();
  render();
}

// เติมหลายตัวในล็อตเดียว โดยคิดต้นทุนเฉลี่ยถ่วงน้ำหนักให้แต่ละตัวเลือก
async function restockVariants(rows, data) {
  const prepared = rows.map(row => {
    if (!row.newOption) {
      const found = findVariant(row.variantId);
      if (!found) throw new Error("สินค้าเดิมถูกลบ กรุณาเลือกสินค้าอีกครั้ง");
      return { ...row, productId: found.product.id, name: found.product.name, color: found.variant.color || "", size: found.variant.size || "", type: found.variant.type, ...measurementsOf(found.variant), price: row.price ?? found.variant.price };
    }
    const product = products.find(product => product.id === row.productId);
    if (!product) throw new Error("ไม่พบสินค้าเดิมที่เลือก กรุณาเลือกใหม่");
    if (!row.color.trim() || !row.size.trim()) throw new Error("กรุณาระบุสีและไซส์ใหม่ให้ครบ");
    return { ...row, name: product.name };
  });
  assertStockRows(prepared);
  for (const row of prepared) {
    const current = products.find(p => p.id === row.productId)?.variants.find(v => stockOptionKey(v) === stockOptionKey(row));
    if (current && !Number.isSafeInteger(current.qty + row.qty)) throw new Error("จำนวนรวมมากเกินกว่าระบบรองรับ");
  }
  const keys = prepared.map(row => JSON.stringify([row.productId, stockOptionKey(row)]));
  if (new Set(keys).size !== keys.length) throw new Error("เลือกสินค้า สี ไซส์ และสภาพซ้ำ กรุณารวมจำนวนไว้ในแถวเดียว");
  assertShipping(Number(data.shippingIn || 0));
  const updated = [];
  prepared.forEach(row => {
    const { prod: product, variant } = addVariantCore(row);
    updated.push({ product, variant, qty: row.qty, batchCost: row.cost });
  });
  if (updated.length === 0)
    throw new Error("ไม่พบสินค้าที่เลือกสำหรับเติมสต๊อก");

  let txAdded = false;
  if (data.logExpense) {
    const costs = allocateCashCosts(updated.map(item => item.batchCost * item.qty));
    updated.forEach(({ product, variant, qty, batchCost }, index) => {
      if (costs[index] <= 0) return;
      transactions.unshift({
        id: uid(),
        type: "expense",
        category: "เติมสต๊อกสินค้าเดิม",
        desc: variantLabel(product, variant) + " +" + qty,
        amount: costs[index],
        date: todayStr(),
        productId: variant.id,
      });
      txAdded = true;
    });
  }
  const shippingIn = parseFloat(data.shippingIn) || 0;
  if (shippingIn > 0) {
    transactions.unshift({
      id: uid(),
      type: "expense",
      category: "ค่าส่งสินค้าเข้า",
      desc:
        updated
          .map(
            ({ product, variant, qty }) =>
              variantLabel(product, variant) + " x" + qty,
          )
          .join(", ") + " (ค่าส่งจากต้นทาง)",
      amount: shippingIn,
      date: todayStr(),
      productId: null,
    });
    txAdded = true;
  }
  await saveData("products", ...(txAdded ? ["transactions"] : []));
  render();
}

async function editVariant(variantId, data) {
  const found = findVariant(variantId);
  if (!found) return;
  if (!data.name.trim() || !["new", "used"].includes(data.type) ||
      !validMeasurements(data) || !Number.isSafeInteger(data.qty) || data.qty < 0 ||
      ![data.cost, data.price].every(value => Number.isFinite(value) && value >= 0)) {
    showAlert("กรุณาระบุชื่อสินค้า จำนวนเต็มตั้งแต่ 0 ราคา/ต้นทุนที่ถูกต้อง และขนาด 0.01–300 นิ้ว (ทศนิยมไม่เกิน 2 ตำแหน่ง หรือเว้นว่าง)");
    return false;
  }
  const { product, variant } = found;
  if (editingVariantSnapshot && JSON.stringify({ name: product.name, variant }) !== editingVariantSnapshot) {
    showAlert("สินค้าเปลี่ยนแปลงระหว่างแก้ไข กรุณาปิดแล้วเปิดข้อมูลล่าสุดอีกครั้ง");
    return false;
  }
  const duplicate = product.variants.some(v => v.id !== variantId && stockOptionKey(v) === stockOptionKey(data));
  if (duplicate || products.some(p => p.id !== product.id && normalizedText(p.name) === normalizedText(data.name))) {
    showAlert("ชื่อสินค้าหรือตัวเลือกสี/ไซส์/สภาพซ้ำและขนาดจริงตรงกัน กรุณาใช้เติมสต็อกหรือรวมข้อมูลซ้ำแทน");
    return false;
  }
  if (variant.qty !== data.qty) {
    try {
      const entry = stockAdjustment(variant, data.qty, variant.qty, data.reason, uid(), new Date().toISOString());
      variant.adjustments = [...(variant.adjustments || []), entry];
    } catch (error) { showAlert(error.message); return false; }
  }
  product.name = data.name.trim();
  setProductColorImage(product, data.color, data.image);
  variant.color = data.color;
  variant.size = data.size;
  Object.assign(variant, measurementsOf(data));
  variant.type = data.type;
  variant.cost = data.cost;
  variant.price = data.price;
  variant.qty = data.qty;
  await saveProducts();
  render();
  return true;
}

async function deleteVariant(variantId) {
  const reviewed = findVariant(variantId);
  if (!reviewed) return;
  if (reviewed.product.variants.length === 1 && pendingOrders.some(order => order.productId === reviewed.product.id)) {
    showAlert("สินค้านี้มีรายการสั่งซื้อรอรับ กรุณารับของหรือยกเลิกรายการรอรับก่อนลบสินค้า");
    return;
  }
  if (reviewed.product.variants.length === 1 && adCampaigns.some(c => campaignHasProduct(c, reviewed.product.id))) {
    showAlert("สินค้านี้มีแคมเปญยิงแอดผูกอยู่ กรุณาเก็บสินค้าไว้เพื่อรักษาประวัติต้นทุนโฆษณา");
    return;
  }
  const snapshot = JSON.stringify(reviewed.variant);
  if (!(await showConfirm(`ลบ ${variantLabel(reviewed.product, reviewed.variant)} ออกจากสต็อก? คงเหลือ ${reviewed.variant.qty} ชิ้น ประวัติปรับยอดของตัวเลือกนี้จะถูกลบ รายการบัญชีเดิมยังคงอยู่`))) return;
  const found = findVariant(variantId);
  if (!found || JSON.stringify(found.variant) !== snapshot) {
    showAlert("สินค้าเปลี่ยนแปลงระหว่างยืนยัน กรุณาตรวจสอบข้อมูลล่าสุด");
    return;
  }
  const { product } = found;
  if (product.variants.length === 1 && (adCampaigns.some(c => campaignHasProduct(c, product.id)) || pendingOrders.some(o => o.productId === product.id))) { showAlert("สินค้ามีรายการที่ผูกเพิ่มระหว่างยืนยัน กรุณาตรวจสอบข้อมูลล่าสุด"); return; }
  product.variants = product.variants.filter((v) => v.id !== variantId);
  if (product.variants.length === 0) {
    products = products.filter((p) => p.id !== product.id);
  }
  await saveData("products", "pendingOrders", "adCampaigns");
  render();
}

function addDaysStr(days) {
  const d = new Date();
  d.setDate(d.getDate() + (parseInt(days, 10) || 30));
  return localDateStr(d);
}

async function sellVariant(variantId, data) {
  const found = findVariant(variantId);
  if (!found) return;
  const { product, variant } = found;
  const qty = Number(data.qty);
  const sellPrice = Number(data.sellPrice);
  const shipping = Number(data.shipping || 0);
  const commission = Number(data.commission || 0);
  const isInstallment = !!data.installment;
  if (!Number.isInteger(qty) || qty < 1) {
    showAlert("ระบุจำนวนที่จะขายเป็นจำนวนเต็มมากกว่า 0");
    return;
  }
  if (qty > variant.qty) {
    showAlert("สินค้าคงเหลือไม่พอ (เหลือ " + variant.qty + " ชิ้น)");
    return;
  }
  if (!validCash(sellPrice) || sellPrice <= 0 || !validCash(money(sellPrice * qty))) {
    showAlert("ระบุราคาขายจริงให้ถูกต้อง");
    return;
  }
  if (
    !validCash(shipping) ||
    shipping < 0 ||
    !validCash(commission) ||
    commission < 0
  ) {
    showAlert("ค่าส่งและค่ากลางต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป");
    return;
  }

  const revenue = money(sellPrice * qty);
  const deposit = Number(data.deposit || 0);
  const dueDays = Number(data.dueDays || 30);
  if (isInstallment && (!validCash(deposit) || deposit < 0 || deposit > revenue ||
      !Number.isSafeInteger(dueDays) || dueDays < 1 || dueDays > 3650)) {
    showAlert("มัดจำต้องตั้งแต่ 0 และไม่เกินยอดขาย วันครบกำหนดต้องเป็นจำนวนเต็ม 1–3650 วัน");
    return;
  }
  const campaign = data.adCampaignId ? adCampaigns.find(c => c.id === data.adCampaignId && campaignHasProduct(c, product.id)) : null;
  if (data.adCampaignId && !campaign) { showAlert("ไม่พบแคมเปญของสินค้านี้ กรุณาเลือกใหม่"); return; }
  const customerNote = String(data.customerNote || "").trim();
  if (customerNote.length > 2000) { showAlert("ข้อมูลผู้รับต้องไม่เกิน 2,000 ตัวอักษร"); return; }
  variant.qty -= qty;

  const profit = money(revenue - variant.cost * qty - shipping - commission);

  if (isInstallment) {
    const saleId = uid();
    const note = (data.customerNote || "").trim();
    transactions.unshift({
      id: saleId,
      type: "installment",
      category: "ขายสินค้า",
      desc:
        variantLabel(product, variant) +
        " x" +
        qty +
        (note ? " — " + note : "") +
        " (ผ่อนชำระ)",
      amount: revenue,
      date: todayStr(),
      productId: variant.id,
      qty,
      unitPrice: sellPrice,
      unitCost: variant.cost,
      shipping,
      commission,
      profit,
      stockProductId: product.id,
      deliveryStatus: "pending",
      ...measurementsOf(variant),
      ...(campaign ? { adCampaignId: campaign.id } : {}),
      paidAmount: deposit,
      dueDate: addDaysStr(data.dueDays),
      customerNote: note,
    });
    if (deposit > 0) {
      transactions.unshift({
        id: uid(),
        type: "income",
        category: "รับชำระค่าผ่อน (มัดจำแรก)",
        desc: variantLabel(product, variant),
        amount: deposit,
        date: todayStr(),
        installmentId: saleId,
        productId: variant.id,
      });
    }
  } else {
    transactions.unshift({
      id: uid(),
      type: "income",
      category: "ขายสินค้า",
      desc: variantLabel(product, variant) + " x" + qty,
      customerNote,
      deliveryStatus: "pending",
      amount: revenue,
      date: todayStr(),
      productId: variant.id,
      qty,
      unitPrice: sellPrice,
      unitCost: variant.cost,
      shipping,
      commission,
      profit,
      stockProductId: product.id,
      ...measurementsOf(variant),
      ...(campaign ? { adCampaignId: campaign.id } : {}),
    });
  }
  if (shipping > 0) {
    transactions.unshift({
      id: uid(),
      type: "expense",
      category: "ค่าส่ง",
      desc: variantLabel(product, variant) + " x" + qty,
      amount: shipping,
      date: todayStr(),
      productId: variant.id,
    });
  }
  if (commission > 0) {
    transactions.unshift({
      id: uid(),
      type: "expense",
      category: "ค่ากลาง",
      desc: variantLabel(product, variant) + " x" + qty,
      amount: commission,
      date: todayStr(),
      productId: variant.id,
    });
  }
  await saveData("products", "transactions", ...(campaign ? ["adCampaigns"] : []));
  render();
  toast("บันทึกการขายแล้ว · สินค้าอยู่ในเมนูรอส่ง");
}

function openInstallments() {
  return transactions.filter(
    (t) => t.type === "installment" && t.amount - (t.paidAmount || 0) > 0.001,
  );
}

async function recordInstallmentPayment(saleTxId, amountStr) {
  const sale = transactions.find(
    (t) => t.id === saleTxId && t.type === "installment",
  );
  if (!sale) return false;
  const amount = Number(amountStr);
  const remaining = sale.amount - (sale.paidAmount || 0);
  if (!validCash(amount) || amount <= 0) {
    showAlert("ระบุจำนวนเงินให้ถูกต้อง");
    return false;
  }
  if (amount > remaining + 0.001) {
    showAlert("จำนวนเงินเกินยอดค้างชำระ (" + fmtMoney(remaining) + ")");
    return false;
  }
  sale.paidAmount = money((sale.paidAmount || 0) + amount);
  transactions.unshift({
    id: uid(),
    type: "income",
    category: "รับชำระค่าผ่อน",
    desc: sale.desc,
    amount,
    date: todayStr(),
    installmentId: sale.id,
    productId: sale.productId,
  });
  await saveTx();
  render();
  return true;
}

async function addManualTx(data) {
  if (
    !validCash(data.amount) ||
    data.amount <= 0 ||
    !["income", "expense"].includes(data.type)
  ) {
    showAlert("ระบุประเภทและจำนวนเงินให้ถูกต้อง");
    return;
  }
  if (data.date && !validDateString(data.date)) {
    showAlert("ระบุวันที่ให้ถูกต้อง");
    return;
  }
  const transaction = {
    id: editingTransaction?.id || uid(),
    source: "manual",
    type: data.type,
    category:
      data.category ||
      (data.type === "income" ? "รายรับอื่นๆ" : "รายจ่ายอื่นๆ"),
    desc: data.desc,
    amount: data.amount,
    date: data.date || todayStr(),
  };
  if (editingTransaction) {
    const index = transactions.findIndex(tx => tx.id === editingTransaction.id);
    if (index < 0 || JSON.stringify(transactions[index]) !== JSON.stringify(editingTransaction) || !isManualTransaction(transactions[index])) {
      showAlert("รายการบัญชีเปลี่ยนแปลงแล้ว กรุณาเปิดรายการล่าสุดก่อนแก้ไข");
      return;
    }
    transactions[index] = transaction;
  } else transactions.unshift(transaction);
  await saveTx();
  editingTransaction = null;
  render();
}

function isManualTransaction(tx) {
  return ["income", "expense"].includes(tx.type) && !tx.adCampaignId && !tx.productId && !tx.installmentId && !tx.preorderId && !tx.items && !tx.pendingIds && tx.profit == null &&
    (tx.source === "manual" || !["ขายสินค้า", "ค่าส่งสินค้าเข้า", "สั่งซื้อสินค้า (รอของมาส่ง)", "ค่าส่ง", "ค่ากลาง"].includes(tx.category));
}

async function deleteTx(id) {
  const target = transactions.find((tx) => tx.id === id);
  if (!target) return;
  if (shipments.some(s => s.items.some(i => i.saleId === id))) {
    showAlert("รายการขายมีประวัติการจัดส่งแล้ว ไม่สามารถลบจากบัญชีได้ กรุณาตรวจสอบที่เมนูรอส่ง");
    return;
  }
  if (isAdSpend(target)) {
    showAlert("รายการค่าแอดผูกกับแคมเปญ กรุณาแก้ไขจากเมนูยิงแอดเพื่อให้ต้นทุนและกำไรตรงกัน");
    return;
  }
  if (target.preorderId) {
    showAlert("รายการนี้ผูกกับ pre-order กรุณาจัดการหรือยกเลิกจากหน้า Pre-order ลูกค้า เพื่อให้ยอดเงินตรงกัน");
    return;
  }
  const linkedPayments =
    target.type === "installment"
      ? transactions.filter((tx) => tx.installmentId === id)
      : [];
  const reviewed = JSON.stringify([target, linkedPayments]);
  const message = linkedPayments.length
    ? `ลบรายการผ่อนนี้และรายการรับชำระที่เกี่ยวข้อง ${linkedPayments.length} รายการ? สต็อกสินค้าจะไม่เปลี่ยนแปลง`
    : (target.productId || target.items || target.pendingIds || target.category === "ขายสินค้า") && !target.installmentId ? "ลบรายการบัญชีนี้? จำนวนสต็อกจะไม่เปลี่ยนแปลง และระบบจะไม่คืนเงินให้อัตโนมัติ" : "ลบรายการนี้?";
  if (!(await showConfirm(message))) return;
  if (reviewed !== JSON.stringify([transactions.find(tx => tx.id === id), target.type === "installment" ? transactions.filter(tx => tx.installmentId === id) : []])) {
    showAlert("รายการบัญชีเปลี่ยนแปลงระหว่างยืนยัน กรุณาตรวจสอบอีกครั้ง");
    return;
  }
  if (target.installmentId) {
    const sale = transactions.find(
      (tx) => tx.id === target.installmentId && tx.type === "installment",
    );
    if (sale)
      sale.paidAmount = Math.max(0, (sale.paidAmount || 0) - target.amount);
  }
  transactions = transactions.filter(
    (tx) =>
      tx.id !== id &&
      !(target.type === "installment" && tx.installmentId === id),
  );
  await saveTx();
  render();
}

async function resetAll() {
  if (
    !(await showConfirm(
      "ล้างข้อมูลสินค้า รายการรอรับ pre-order ลูกค้า แคมเปญยิงแอด ประวัติเติมเงิน การจัดส่ง และบัญชีทั้งหมด? การกระทำนี้ย้อนกลับไม่ได้",
    ))
  )
    return;
  products = [];
  transactions = [];
  pendingOrders = [];
  preorders = [];
  adCampaigns = [];
  adWallet = [];
  shipments = [];
  await saveData(...STORE_NAMES);
  render();
}

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        // เก็บรูปขนาดเล็กเพื่อไม่ให้เอกสาร Firestore ใหญ่เกินขีดจำกัด
        const maxDim = 200;
        let w = img.width,
          h = img.height;
        if (w > h && w > maxDim) {
          h = Math.round((h * maxDim) / w);
          w = maxDim;
        } else if (h > maxDim) {
          w = Math.round((w * maxDim) / h);
          h = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.6));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------- Render ----------
const tabMeta = {
  home: [
    "ภาพรวมร้านค้า",
    "ภาพรวม",
    "home",
    "ทุกความเคลื่อนไหวของร้าน ในที่เดียว",
  ],
  tasks: ["งานที่ต้องติดตาม", "งานที่ต้องติดตาม", "check", "รวมสต็อก ของรอรับ ออเดอร์ลูกค้า และยอดค้างไว้ในหน้าเดียว"],
  stock: [
    "สต็อกสินค้า",
    "สต็อกสินค้า",
    "box",
    "จัดการสินค้า เติมสต็อก และรับสินค้าเข้า",
  ],
  ads: ["ยิงแอดและต้นทุนโฆษณา", "ยิงแอด", "chart", "ผูกสินค้า วางงบ ติดตามกำไร และเก็บเงินยิงแอดต่อ"],
  preorder: ["Pre-order ลูกค้า", "Pre-order ลูกค้า", "clock", "รับจอง ติดตามมัดจำ และส่งมอบสินค้าที่ลูกค้าพรีกับร้าน"],
  sell: ["ขายสินค้า", "ขายสินค้า", "bag", "พร้อมสำหรับออเดอร์ถัดไปของคุณ"],
  shipments: ["จัดส่งสินค้า", "รอส่ง", "box", "รวมสินค้าที่ขายแล้ว เลือกหลายรายการ และบันทึกพัสดุที่ส่ง"],
  installment: [
    "ติดตามการผ่อนชำระ",
    "ผ่อนชำระ",
    "wallet",
    "ติดตามยอดค้างและบันทึกการรับชำระ",
  ],
  tx: [
    "บัญชีร้านค้า",
    "รายรับ–รายจ่าย",
    "receipt",
    "ดูแลทุกรายรับ และทุกรายจ่าย",
  ],
  report: [
    "รายงานและสถิติ",
    "รายงาน",
    "chart",
    "มองเห็นผลลัพธ์ เพื่อวางแผนก้าวต่อไป",
  ],
  ai: [
    "ข้อมูลเชิงลึก",
    "วิเคราะห์แนวโน้ม",
    "sparkles",
    "เปลี่ยนข้อมูลร้านให้เป็นแนวทางที่นำไปใช้ได้",
  ],
};
let stockWorkspace = "inventory";
let inventorySearch = "";
let inventoryStatus = "all";
let inventoryCondition = "all";
let inventorySort = "name";
let homeFilter = "all";
let sellSearch = "";
let txSearch = "";
let editingTransaction = null;
let txTypeFilter = "all";
let txMonthFilter = "";
function icon(name, extra = "") {
  const paths = {
    home: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    box: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/>',
    bag: '<path d="M5 7h14l1 14H4L5 7Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    wallet:
      '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 8V5l14-3v3M21 11h-6v5h6"/><path d="M17 13.5h.01"/>',
    receipt:
      '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 7h6M9 11h6M9 15h3"/>',
    chart: '<path d="M4 3v17h17M8 15l4-5 4 2 5-7"/>',
    sparkles:
      '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3ZM20 2v4M18 4h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    up: '<path d="m5 16 6-6 4 4 6-10M16 4h5v5"/>',
    down: '<path d="m5 8 6 6 4-4 6 10M16 20h5v-5"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    upload: '<path d="M12 15V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    shirt: '<path d="m8 3-6 4 3 5 3-2v11h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
    refresh:
      '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  };
  return `<svg class="icon ${extra}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.box}</svg>`;
}
function navigateTo(tab, workspace) {
  activeTab = tabMeta[tab] ? tab : "home";
  if (activeTab !== "tx") editingTransaction = null;
  if (workspace) stockWorkspace = workspace;
  history.replaceState(null, "", "#" + activeTab);
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function themeToggle() {
  const dark = document.documentElement.dataset.theme !== "light";
  return `<button id="theme-toggle" class="theme-toggle" type="button" aria-pressed="${dark}" aria-label="${dark ? "เปลี่ยนเป็นโหมดสว่าง" : "เปลี่ยนเป็นโหมดมืด"}" title="${dark ? "เปลี่ยนเป็นโหมดสว่าง" : "เปลี่ยนเป็นโหมดมืด"}"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path class="theme-moon" d="M20 14a8 8 0 0 1-10-10A8.5 8.5 0 1 0 20 14Z"/><g class="theme-sun"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></g></svg><span class="theme-toggle-label">${dark ? "โหมดมืด" : "โหมดสว่าง"}</span></button>`;
}
function metric(label, value, note, symbol, tone = "") {
  return `<div class="stat glass ${tone}"><div class="stat-top"><span class="lbl">${label}</span><span class="stat-icon">${icon(symbol)}</span></div><div class="val">${value}</div><div class="stat-note">${note}</div></div>`;
}
function render() {
  if (!loaded) {
    app.innerHTML = `<div class="loading-screen glass"><div class="loading-brand">C<span>↗</span></div><p class="eyebrow">CRAZSIX WORKSPACE</p><h1>${loadError ? "ยังเชื่อมต่อข้อมูลไม่ได้" : "กำลังเตรียมร้านของคุณ"}</h1><p>${loadError ? "ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต แล้วลองอีกครั้ง" : "กำลังโหลดสต็อกและรายการล่าสุด"}</p>${loadError ? '<button class="btn btn-primary" id="retry-load">ลองอีกครั้ง</button>' : '<div class="loading-track"><span></span></div>'}</div>`;
    const retry = document.getElementById("retry-load");
    if (retry)
      retry.onclick = () => {
        loadError = false;
        render();
        loadAll();
      };
    return;
  }
  if (trendChartInstance) { trendChartInstance.destroy(); trendChartInstance = null; }
  if (sellersChartInstance) { sellersChartInstance.destroy(); sellersChartInstance = null; }
  if (typeof markRenderComplete === "function") markRenderComplete();
  const ms = monthSummary(todayStr().slice(0, 7));
  const meta = tabMeta[activeTab] || tabMeta.home;
  const totalQty = allVariants().reduce(
    (sum, { variant }) => sum + variant.qty,
    0,
  );
  const dateLabel = new Date().toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  app.innerHTML = `
    <aside class="sidebar glass">
      <a class="brand" href="#home" aria-label="Crazsix หน้าหลัก"><span class="brand-mark">C<span>↗</span></span><span><strong>crazsix<span class="brand-dot">.</span></strong><small>STORE WORKSPACE</small></span></a>
      <div class="workspace-label">พื้นที่จัดการร้าน</div>
      <nav class="tabs" aria-label="เมนูหลัก">${Object.entries(tabMeta)
        .map(
          ([key, item]) =>
            `<button data-tab="${key}" aria-label="${item[1]}" title="${item[1]}" class="${activeTab === key ? "active" : ""}" ${activeTab === key ? 'aria-current="page"' : ""}>${icon(item[2])}<span>${item[1]}</span>${key === "installment" && openInstallments().length ? `<span class="nav-count">${openInstallments().length}</span>` : ""}${key === "shipments" && pendingDeliveries(transactions,shipments).length ? `<span class="nav-count">${pendingDeliveries(transactions,shipments).length}</span>` : ""}</button>`,
        )
        .join("")}</nav>
      <div class="sidebar-bottom"><div class="workspace-note">${icon("sparkles")}<strong>Small store. Big possibilities.</strong><p>ดูแลร้านให้คล่องตัว<br>มีเวลาให้สิ่งที่คุณรักมากขึ้น</p></div><div class="store-profile"><span class="avatar">C</span><div><strong>Crazsix Store</strong><small>ระบบจัดการร้านเสื้อผ้า</small></div><span class="online-dot" title="โหลดข้อมูลแล้ว"></span></div></div>
    </aside>
    <main class="main-content" id="main-content">
      <div class="topbar"><div class="breadcrumb">Workspace <span>/</span> <strong>${meta[1]}</strong></div><div class="topbar-right">${themeToggle()}<span class="sync-status"><span class="online-dot"></span>เชื่อมต่อแล้ว</span><span class="topbar-date">${icon("calendar")}${dateLabel}</span><span class="avatar avatar-small">C</span></div></div>
      <header class="page-header"><div><p class="eyebrow">${activeTab === "home" ? "YOUR STORE, AT A GLANCE" : "CRAZSIX STORE"}</p><h1>${meta[0]}<span class="heading-dot">.</span></h1><p class="subline">${meta[3]}</p></div><div class="header-actions"><button class="btn btn-ghost" data-go="stock" data-workspace="add">${icon("plus")}เพิ่มสินค้า</button><button class="btn btn-primary" data-go="sell">${icon("bag")}บันทึกการขาย</button></div></header>
      ${activeTab === "home" ? `<section class="stats" aria-label="สรุปร้านเดือนนี้">${metric("มูลค่าสต็อก", fmtMoney(stockValue()), `${products.length} สินค้า · คงเหลือ ${totalQty.toLocaleString("th-TH")} ชิ้น`, "box")}${metric("รายรับเดือนนี้", fmtMoney(ms.income), "เงินที่รับแล้วในเดือนนี้", "up", "income-stat")}${metric("รายจ่ายเดือนนี้", fmtMoney(ms.expense), "รวมต้นทุนซื้อเข้าและค่าใช้จ่าย", "down", "expense-stat")}${metric("เงินสุทธิเดือนนี้", fmtMoney(ms.profit), "รายรับ − รายจ่าย", "wallet", "profit")}</section>` : ""}
      <div id="tab-content" class="tab-content"></div>
      <footer><span>CRAZSIX <span class="footer-dot">•</span> Your everyday store companion</span><details class="data-tools"><summary>จัดการข้อมูล ${icon("chevron")}</summary><div class="footer-actions"><button id="export-btn">${icon("download")}สำรองข้อมูล</button><button id="import-btn">${icon("upload")}นำเข้าข้อมูล</button><button data-export="inventory">ส่งออกสต็อก CSV</button><button data-export="transactions">ส่งออกบัญชี CSV</button><button data-export="preorders">ส่งออก pre-order CSV</button><button id="reset-btn" class="danger-text">ล้างข้อมูลทั้งหมด</button></div></details><input type="file" id="import-input" accept=".json,application/json" hidden></footer>
    </main>`;
  document
    .querySelectorAll("nav.tabs button")
    .forEach((b) => (b.onclick = () => navigateTo(b.dataset.tab)));
  document.querySelector(".brand").onclick = (e) => {
    e.preventDefault();
    navigateTo("home");
  };
  document.getElementById("reset-btn").onclick = resetAll;
  document.getElementById("export-btn").onclick = () => {
    exportData();
    toast("ดาวน์โหลดไฟล์สำรองข้อมูลแล้ว");
  };
  document.getElementById("import-input").onchange = handleImportFile;
  document.getElementById("import-btn").onclick = () =>
    document.getElementById("import-input").click();
  const content = document.getElementById("tab-content");
  if (activeTab === "tasks") content.innerHTML = renderTasksTab();
  else if (activeTab === "home")
    content.innerHTML = renderDashboard() + renderHomeTab();
  else if (activeTab === "stock") content.innerHTML = renderStockTab();
  else if (activeTab === "preorder") content.innerHTML = renderPreordersTab();
  else if (activeTab === "ads") content.innerHTML = renderAds(storeValues(), { today: todayStr(), esc: escapeHtml, fmt: fmtMoney, metric });
  else if (activeTab === "sell") content.innerHTML = renderSellTab();
  else if (activeTab === "shipments") content.innerHTML = renderShipments(storeValues(), {today:todayStr(), esc:escapeHtml, fmt:fmtMoney, metric});
  else if (activeTab === "installment")
    content.innerHTML = renderInstallmentsTab();
  else if (activeTab === "tx") content.innerHTML = renderTxTab();
  else if (activeTab === "report") content.innerHTML = renderRangeReport() + renderReportTab();
  else content.innerHTML = renderAiTab();
  wireAdsTab();
  wireShipmentsTab();
  wireTasksTab();
  wireExportTools();
  wireHomeTab();
  wireStockTab();
  wireProductAds();
  wireSellTab();
  wirePreordersTab();
  wireInstallmentsTab();
  wireTxTab();
  wireReportTab();
  wireAiTab();
  if (activeTab === "stock") setupStockWorkspace(content);
  document
    .querySelectorAll("[data-go]")
    .forEach(
      (b) => (b.onclick = () => navigateTo(b.dataset.go, b.dataset.workspace)),
    );
  enhanceUI();
}
function renderDashboard() {
  const months = last6MonthsKeys();
  const summaries = months.map(monthSummary);
  const max = Math.max(...summaries.flatMap((s) => [s.income, s.expense]), 1);
  const points = summaries.map((s, i) => [
    i * 100,
    145 - (s.income / max) * 116,
  ]);
  const expensePoints = summaries.map((s, i) => [
    i * 100,
    145 - (s.expense / max) * 116,
  ]);
  const line = points.map((p) => p.join(",")).join(" ");
  const expenseLine = expensePoints.map((p) => p.join(",")).join(" ");
  const low = lowStockVariants();
  const open = openInstallments();
  const balance = open.reduce((s, t) => s + t.amount - (t.paidAmount || 0), 0);
  return `<section class="dashboard-grid"><div class="panel overview-chart"><div class="section-heading"><div><p class="eyebrow">CASH FLOW</p><h2>ความเคลื่อนไหวของร้าน</h2></div><button class="text-button" data-go="report">ดูรายงาน ${icon("arrow")}</button></div><div class="chart-legend"><span><i class="legend-dot blue"></i>รายรับ</span><span><i class="legend-dot lavender"></i>รายจ่าย</span><span class="period-label">6 เดือนล่าสุด</span></div><div class="cash-chart"><div class="chart-scale"><span>${fmtMoney(max)}</span><span>${fmtMoney(max / 2)}</span><span>฿0</span></div><div class="chart-plot"><svg viewBox="0 0 500 160" preserveAspectRatio="none" role="img" aria-label="กราฟรายรับและรายจ่าย 6 เดือนล่าสุด"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6f80ed" stop-opacity=".3"/><stop offset="100%" stop-color="#6f80ed" stop-opacity="0"/></linearGradient></defs><path d="M0 29H500M0 87H500M0 145H500" stroke="#b7c1d4" stroke-opacity=".35" stroke-dasharray="3 5"/><polygon points="0,155 ${line} 500,155" fill="url(#chart-fill)"/><polyline points="${expenseLine}" fill="none" stroke="#b19ccc" stroke-width="2.4" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/><polyline points="${line}" fill="none" stroke="#687ce5" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#687ce5"/>`).join("")}</svg><div class="chart-months">${months.map((m) => `<span>${monthLabel(m).split(" ")[0]}</span>`).join("")}</div></div></div><details class="chart-data"><summary>ดูตัวเลขรายเดือน</summary><table><thead><tr><th>เดือน</th><th>รายรับ</th><th>รายจ่าย</th></tr></thead><tbody>${months.map((m, i) => `<tr><td>${monthLabel(m)}</td><td>${fmtMoney(summaries[i].income)}</td><td>${fmtMoney(summaries[i].expense)}</td></tr>`).join("")}</tbody></table></details></div><div class="panel attention-panel"><div class="section-heading"><div><p class="eyebrow">ON YOUR RADAR</p><h2>เรื่องที่ต้องดูแล</h2></div><span class="radar-orb">${icon("sparkles")}</span></div><button class="attention-row" data-go="stock" data-workspace="inventory"><span class="attention-icon amber">${icon("box")}</span><span><strong>สินค้าใกล้หมด</strong><small>เช็กสต็อกก่อนพลาดการขาย</small></span><b>${low.length}<small>ตัวเลือก</small></b>${icon("chevron")}</button><button class="attention-row" data-go="stock" data-workspace="pending"><span class="attention-icon blue">${icon("clock")}</span><span><strong>สินค้ารอรับเข้า</strong><small>ยืนยันเมื่อสินค้าเดินทางมาถึง</small></span><b>${pendingOrders.length}<small>รายการ</small></b>${icon("chevron")}</button><button class="attention-row" data-go="installment"><span class="attention-icon violet">${icon("wallet")}</span><span><strong>ยอดรอรับชำระ</strong><small>จาก ${open.length} รายการผ่อนชำระ</small></span><b>${fmtMoney(balance)}</b>${icon("chevron")}</button><button class="attention-row" data-go="preorder"><span class="attention-icon blue">${icon("bag")}</span><span><strong>Pre-order ลูกค้า</strong><small>รายการรับจองที่ยังรอส่งมอบ</small></span><b>${preorders.filter(preorderOpen).length}<small>รายการ</small></b>${icon("chevron")}</button><div class="attention-foot">${icon("check")}ข้อมูลสรุปจากรายการจริงของร้าน</div></div></section>`;
}
function setupStockWorkspace(content) {
  const panels = [...content.children].filter((el) =>
    el.classList.contains("panel"),
  );
  const countPanel = document.createElement("section");
  countPanel.className = "panel";
  countPanel.innerHTML = renderStocktake();
  content.append(countPanel);
  const workspaces = [
    ["inventory", "รายการสินค้า", panels[3]],
    ["add", "เพิ่ม / เติมสต็อก", panels[0]],
    ["pending", `รอรับของ (${pendingOrders.length})`, panels[1]],
    ["shipping", "บันทึกค่าส่ง", panels[2]],
    ["count", "ตรวจนับสต็อก", countPanel],
  ];
  const nav = document.createElement("div");
  nav.className = "workspace-tabs";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "จัดการสต็อก");
  nav.innerHTML = workspaces
    .map(
      ([key, label]) =>
        `<button role="tab" id="workspace-tab-${key}" aria-controls="workspace-${key}" data-workspace-tab="${key}">${label}</button>`,
    )
    .join("");
  content.prepend(nav);
  const inventory = panels[3];
  if (inventory && inventory.querySelector("table")) {
    const toolbar = document.createElement("div");
    toolbar.className = "inventory-toolbar";
    toolbar.innerHTML = `<div class="field search-field">${icon("search")}<input id="stock-search" type="search" aria-label="ค้นหาสต็อกสินค้า" placeholder="ค้นหาชื่อสินค้า สี หรือไซส์" value="${escapeHtml(inventorySearch)}"></div><span class="inventory-count" id="stock-filter-count" role="status"></span>`;
    inventory.querySelector(".panel-title-action").after(toolbar);
    const controls = document.createElement("div");
    controls.className = "stock-filters";
    controls.innerHTML = `<div class="field"><label>สถานะสต็อก</label><select id="stock-status">${Object.entries({all:"ทุกสถานะ",available:"มีสินค้า",low:"ใกล้หมด (1 ชิ้น)",out:"หมด / ติดลบ"}).map(([key,label]) => `<option value="${key}" ${inventoryStatus === key ? "selected" : ""}>${label}</option>`).join("")}</select></div><div class="field"><label>สภาพ</label><select id="stock-condition"><option value="all">ทั้งหมด</option><option value="new" ${inventoryCondition === "new" ? "selected" : ""}>มือหนึ่ง</option><option value="used" ${inventoryCondition === "used" ? "selected" : ""}>มือสอง</option></select></div><div class="field"><label>เรียงตาม</label><select id="stock-sort">${Object.entries({name:"ชื่อสินค้า",qty:"จำนวนน้อยก่อน",value:"มูลค่าสูงก่อน"}).map(([key,label]) => `<option value="${key}" ${inventorySort === key ? "selected" : ""}>${label}</option>`).join("")}</select></div><button class="btn btn-ghost btn-sm" id="stock-clear">ล้างตัวกรอง</button><button class="btn btn-ghost btn-sm" id="stock-export-filtered">ส่งออกที่แสดง CSV</button><p class="hint" id="stock-visible-totals" role="status"></p>`;
    toolbar.after(controls);
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "ไม่พบสินค้าที่ตรงกับคำค้นหา";
    empty.hidden = true;
    inventory.append(empty);
    const search = toolbar.querySelector("input");
    function filter() {
      inventorySearch = search.value;
      inventoryStatus = controls.querySelector("#stock-status").value;
      inventoryCondition = controls.querySelector("#stock-condition").value;
      inventorySort = controls.querySelector("#stock-sort").value;
      const lookup = new Map(allVariants().map(item => [item.variant.id, item]));
      let count = 0, qty = 0, value = 0;
      inventory.querySelectorAll("tbody tr").forEach(row => {
        const visible = [];
        row.querySelectorAll("[data-stock-variant]").forEach(item => {
          const found = lookup.get(item.dataset.stockVariant);
          const v = found?.variant;
          const match = v && normalizedText(variantLabel(found.product, v)).includes(normalizedText(inventorySearch)) &&
            (inventoryCondition === "all" || v.type === inventoryCondition) &&
            (inventoryStatus === "all" || (inventoryStatus === "available" ? v.qty > 0 : inventoryStatus === "low" ? v.qty > 0 && v.qty <= LOW_STOCK_THRESHOLD : v.qty <= 0));
          item.hidden = !match;
          if (match) visible.push(v);
        });
        row.hidden = visible.length === 0;
        const rowQty = visible.reduce((sum,v) => sum + v.qty, 0), rowValue = visible.reduce((sum,v) => sum + v.qty * v.cost, 0);
        row.dataset.visibleQty = rowQty; row.dataset.visibleValue = rowValue;
        row.children[4].textContent = rowQty;
        row.children[5].textContent = fmtMoney(rowQty ? rowValue / rowQty : 0);
        row.children[6].textContent = fmtMoney(rowValue);
        if (!row.hidden) { count++; qty += rowQty; value += rowValue; }
      });
      inventory.querySelectorAll("tbody").forEach(body => {
        [...body.children].sort((a,b) => inventorySort === "qty" ? Number(a.dataset.visibleQty) - Number(b.dataset.visibleQty) : inventorySort === "value" ? Number(b.dataset.visibleValue) - Number(a.dataset.visibleValue) : a.children[1].textContent.localeCompare(b.children[1].textContent, "th")).forEach(row => body.append(row));
      });
      inventory.querySelectorAll("[data-stock-section]").forEach(section => {
        const visibleCount = section.querySelectorAll("tbody tr:not([hidden])").length;
        section.hidden = visibleCount === 0;
        section.querySelector(".stock-section-count").textContent = `${visibleCount} กลุ่มสินค้า`;
      });
      toolbar.querySelector("#stock-filter-count").textContent = `${count} กลุ่มสินค้า`;
      controls.querySelector("#stock-visible-totals").textContent = `เฉพาะที่แสดง: ${qty} ชิ้น · มูลค่า ${fmtMoney(value)}`;
      empty.hidden = count > 0;
    }
    controls.querySelectorAll("select").forEach(select => { select.onchange = filter; });
    controls.querySelector("#stock-clear").onclick = () => {
      search.value = "";
      controls.querySelector("#stock-status").value = "all";
      controls.querySelector("#stock-condition").value = "all";
      controls.querySelector("#stock-sort").value = "name";
      filter();
    };
    controls.querySelector("#stock-export-filtered").onclick = () => {
      const ids = new Set([...inventory.querySelectorAll('[data-stock-variant]:not([hidden])')].map(item => item.dataset.stockVariant));
      downloadCsv("filtered-stock", [["รหัส", "สินค้า", "สี", "ไซส์", "อก (นิ้ว)", "ความยาว (นิ้ว)", "สภาพ", "จำนวน", "ต้นทุนต่อชิ้น", "ราคาขาย", "มูลค่า"], ...allVariants().filter(({variant}) => ids.has(variant.id)).map(({product, variant:v}) => [v.id, product.name, v.color, v.size, v.chestInches ?? "", v.lengthInches ?? "", v.type, v.qty, v.cost, v.price, money(v.qty * v.cost)])]);
    };
    search.oninput = filter;
    filter();
  }
  function select(key) {
    stockWorkspace = key;
    workspaces.forEach(([id, , panel]) => {
      if (panel) {
        panel.hidden = id !== key;
        panel.id = "workspace-" + id;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", "workspace-tab-" + id);
      }
    });
    nav.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.workspaceTab === key);
      b.setAttribute("aria-selected", String(b.dataset.workspaceTab === key));
    });
  }
  nav
    .querySelectorAll("button")
    .forEach((b) => (b.onclick = () => select(b.dataset.workspaceTab)));
  select(stockWorkspace);
  wireStocktake();
}
function toast(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("visible"), 3500);
}
let nextControlId = 0;
function enhanceUI() {
  document.querySelectorAll("table").forEach((table) => {
    if (!table.parentElement.classList.contains("table-scroll")) {
      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      wrap.tabIndex = 0;
      wrap.setAttribute("aria-label", "ตารางข้อมูล เลื่อนเพื่อดูเพิ่มเติม");
      table.before(wrap);
      wrap.append(table);
    }
  });
  document
    .querySelectorAll('input:not([type="hidden"]), select, textarea')
    .forEach((el, i) => {
      if (el.closest(".type-toggle")) return;
      const label =
        el.previousElementSibling?.tagName === "LABEL"
          ? el.previousElementSibling
          : el.closest(".field")?.querySelector("label");
      if (label && !label.querySelector("input")) {
        if (!el.id) el.id = "auto-field-" + ++nextControlId;
        label.htmlFor = el.id;
      }
      if (!el.labels?.length && !el.hasAttribute("aria-label"))
        el.setAttribute(
          "aria-label",
          el.placeholder ||
            el.name ||
            (el.type === "checkbox" ? "เลือกรายการ" : "ระบุข้อมูล"),
        );
    });
  document.querySelectorAll(".thumb-ph").forEach((el) => {
    if (!el.querySelector("svg")) el.innerHTML = icon("shirt");
  });
}

// ---------- Home tab ----------
function renderHomeTab() {
  const low = lowStockVariants();
  const q = stockSearch.trim().toLowerCase();
  const matchesQuery = (product, variant) =>
    (!q ||
      [product.name, variant.color, variant.size, measurementLabel(variant)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)) &&
    (homeFilter === "all" ||
      (homeFilter === "low"
        ? variant.type === "new" &&
          variant.qty > 0 &&
          variant.qty <= LOW_STOCK_THRESHOLD
        : variant.type === homeFilter));

  const groups = stockColorGroups()
    .map((group) => {
      const variants = group.variants.filter(
        ({ product, variant }) =>
          matchesQuery(product, variant) &&
          !(variant.type === "used" && variant.qty <= 0),
      );
      return { ...group, variants };
    })
    .filter((g) => g.variants.length > 0);

  const soldOutGroups = stockColorGroups()
    .map((group) => {
      const variants = group.variants.filter(
        ({ product, variant }) =>
          matchesQuery(product, variant) &&
          variant.type === "used" &&
          variant.qty <= 0,
      );
      return { ...group, variants };
    })
    .filter((g) => g.variants.length > 0);

  const alertBlock =
    low.length === 0
      ? ""
      : `
    <div class="alert-banner">
      <div class="alert-title">⚠️ สินค้ามือ1 ใกล้หมด (เหลือ ≤ ${LOW_STOCK_THRESHOLD} ชิ้น)</div>
      <div class="alert-list">
        ${low.map(({ product, variant }) => `<span class="alert-chip">${escapeHtml(variantLabel(product, variant))} — เหลือ ${variant.qty}</span>`).join("")}
      </div>
    </div>
  `;

  const pendingBlock =
    pendingOrders.length === 0
      ? ""
      : `
    <div class="alert-banner" style="background: linear-gradient(160deg, #e6edfb, #dbe6fa);">
      <div class="alert-title" style="color:var(--navy-2);">📦 มีสินค้ารอรับของ ${pendingOrders.length} รายการ (จ่ายเงินแล้ว ยังไม่เข้าสต็อก)</div>
      <div class="alert-list">
        ${pendingOrders.map((po) => `<span class="alert-chip" style="color:var(--navy-2);">${escapeHtml(pendingLabel(po))} x${po.qty}</span>`).join("")}
      </div>
    </div>
  `;

  const groupHtml = groups
    .map((group) => {
      const totalQty = group.variants.reduce(
        (sum, { variant }) => sum + variant.qty,
        0,
      );
      const rows = [...group.variants]
        .sort((a, b) => compareSizes(a.variant.size, b.variant.size))
        .map(({ variant: v }) => {
          const isLow =
            v.type === "new" && v.qty > 0 && v.qty <= LOW_STOCK_THRESHOLD;
          const parts = [];
          if (v.size) parts.push("ไซส์ " + escapeHtml(v.size));
          parts.push(v.type === "used" ? "มือ2" : "มือ1");
          return `
        <div class="variant-row ${v.qty <= 0 ? "out" : ""} ${isLow ? "low" : ""}">
          <div class="variant-info">${parts.join(" · ")}${renderMeasurementDetails(v)}</div>
          <div class="variant-qty">${v.qty}</div>
          <button class="btn btn-ghost btn-sm" data-stats="${v.id}">สถิติ</button>
        </div>
      `;
        })
        .join("");
      return `
      <div class="prod-group">
        <div class="prod-group-head">
          <div class="thumb" style="width:44px;height:44px;">${group.image ? `<img src="${escapeHtml(group.image)}" alt="">` : '<span class="thumb-ph">👕</span>'}</div>
          <div class="prod-group-name">${escapeHtml(group.name)} <span class="prod-group-color">· ${escapeHtml(group.color)}</span></div>
          <div class="prod-group-total">รวม ${totalQty} ชิ้น</div>
        </div>
        ${rows}
      </div>
    `;
    })
    .join("");

  const soldOutHtml =
    soldOutGroups.length === 0
      ? ""
      : `
    <div class="soldout-section">
      <h3 class="soldout-title">📪 สินค้ามือสองที่ขายหมดแล้ว (Sold out) — ของมือสองหายาก ไม่ต้องเติมสต็อก</h3>
      <div class="home-list">
        ${soldOutGroups
          .map((group) => {
            const rows = [...group.variants]
              .sort((a, b) => compareSizes(a.variant.size, b.variant.size))
              .map(
                ({ variant: v }) => `
            <div class="variant-row out">
              <div class="variant-info">${v.size ? "ไซส์ " + escapeHtml(v.size) : "-"}${renderMeasurementDetails(v)}</div>
              <span class="tag soldout">หมดแล้ว</span>
              <button class="btn btn-ghost btn-sm" data-stats="${v.id}">สถิติ</button>
            </div>
          `,
              )
              .join("");
            return `
            <div class="prod-group soldout-group">
              <div class="prod-group-head">
                <div class="thumb" style="width:44px;height:44px;">${group.image ? `<img src="${escapeHtml(group.image)}" alt="">` : '<span class="thumb-ph">👕</span>'}</div>
                <div class="prod-group-name">${escapeHtml(group.name)} <span class="prod-group-color">· ${escapeHtml(group.color)}</span></div>
              </div>
              ${rows}
            </div>
          `;
          })
          .join("")}
      </div>
    </div>
  `;

  return `
    <div class="panel">
      <div class="section-heading"><div><p class="eyebrow">YOUR COLLECTION</p><h2>สินค้าของคุณ</h2></div><button class="text-button" data-go="stock">จัดการสต็อก ${icon("arrow")}</button></div>
      <div class="inventory-toolbar"><div class="field search-field">${icon("search")}<input type="search" id="home-search" aria-label="ค้นหาสินค้าในภาพรวม" placeholder="ค้นหาชื่อสินค้า สี หรือไซส์" value="${escapeHtml(stockSearch)}"></div><span class="inventory-count">${groups.length + soldOutGroups.length} กลุ่มสินค้า</span></div>
      <div class="filter-tabs" aria-label="กรองสินค้า">${[
        ["all", "ทั้งหมด"],
        ["new", "มือหนึ่ง"],
        ["used", "มือสอง"],
        ["low", "ใกล้หมด"],
      ]
        .map(
          ([key, label]) =>
            `<button data-home-filter="${key}" aria-pressed="${homeFilter === key}" class="${homeFilter === key ? "active" : ""}">${label}</button>`,
        )
        .join("")}</div>
      ${homeFilter === "low" ? alertBlock : ""}
      ${
        groups.length === 0
          ? `
        <div class="empty">
          <div class="big">${products.length === 0 ? "เริ่มต้นคอลเลกชันของร้านคุณ" : "ไม่พบสินค้าที่ค้นหา"}</div>${products.length === 0 ? '<p>เพิ่มสินค้าชิ้นแรก แล้วจัดการทุกออเดอร์ได้จากที่นี่</p><button class="btn btn-primary" data-go="stock" data-workspace="add">เพิ่มสินค้าชิ้นแรก</button>' : "ลองเปลี่ยนคำค้นหาหรือตัวกรอง"}
        </div>`
          : `<div class="home-list">${groupHtml}</div>`
      }
      ${soldOutHtml}
    </div>
  `;
}

function wireHomeTab() {
  const search = document.getElementById("home-search");
  if (search)
    search.oninput = () => {
      stockSearch = search.value;
      const start = search.selectionStart;
      render();
      const next = document.getElementById("home-search");
      next.focus({ preventScroll: true });
      if (start !== null) next.setSelectionRange(start, start);
    };
  document.querySelectorAll("[data-home-filter]").forEach(
    (btn) =>
      (btn.onclick = () => {
        homeFilter = btn.dataset.homeFilter;
        render();
      }),
  );
  document
    .querySelectorAll("[data-stats]")
    .forEach(
      (btn) => (btn.onclick = () => openVariantDetail(btn.dataset.stats)),
    );
}

function renderMonthTable(months) {
  if (months.length === 0)
    return '<p class="hint" style="margin-top:14px;">ยังไม่มีประวัติการขาย</p>';
  const rows = months
    .map(
      (m) => `
    <tr><td>${monthLabel(m.key)}</td><td class="num">${m.qty}</td><td class="num" style="color:${m.profit < 0 ? "var(--red)" : "var(--green)"}">${fmtMoney(m.profit)}</td></tr>
  `,
    )
    .join("");
  return `
    <p class="hint" style="margin-top:16px;">กำไรแยกรายเดือน</p>
    <table>
      <thead><tr><th>เดือน</th><th class="num">จำนวนที่ขาย</th><th class="num">กำไร</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function openVariantDetail(variantId) {
  const found = findVariant(variantId);
  if (!found) return;
  const { product, variant } = found;
  const s = variantStats(variantId);
  document.getElementById("detail-body").innerHTML = `
    <div style="display:flex; gap:14px; align-items:center; margin-bottom:16px;">
      <div class="thumb" style="width:60px;height:60px;">${product.image ? `<img src="${escapeHtml(product.image)}" alt="">` : '<span class="thumb-ph" style="font-size:24px;">👕</span>'}</div>
      <div>
        <div style="font-family:var(--font); font-weight:700; font-size:17px; color:var(--navy);">${escapeHtml(product.name)}</div>
        <div style="font-size:12.5px; color:var(--ink-soft); font-weight:600;">${escapeHtml(variantLabel(product, variant))} · คงเหลือ ${variant.qty}</div>
      </div>
    </div>
    <div class="detail-stats">
      <div class="detail-stat"><div class="lbl">ขายไปแล้วทั้งหมด</div><div class="val">${s.totalQtySold} ชิ้น</div></div>
      <div class="detail-stat"><div class="lbl">กำไรรวม (All time)</div><div class="val" style="color:${s.totalProfit < 0 ? "var(--red)" : "var(--green)"}">${fmtMoney(s.totalProfit)}</div></div>
    </div>
    ${renderMonthTable(s.months)}
    ${renderProductAds(product.id)}
  `;
  wireProductAds();
  document.getElementById("detail-overlay").classList.add("show");
}

function openProductAggDetail(productId) {
  const prod = products.find((p) => p.id === productId);
  if (!prod) return;
  const s = productAggregateStats(productId);
  const totalQty = prod.variants.reduce((sum, v) => sum + v.qty, 0);
  document.getElementById("detail-body").innerHTML = `
    <div style="display:flex; gap:14px; align-items:center; margin-bottom:16px;">
      <div class="thumb" style="width:60px;height:60px;">${prod.image ? `<img src="${prod.image}" alt="">` : '<span class="thumb-ph" style="font-size:24px;">👕</span>'}</div>
      <div>
        <div style="font-family:var(--font); font-weight:700; font-size:17px; color:var(--navy);">${escapeHtml(prod.name)}</div>
        <div style="font-size:12.5px; color:var(--ink-soft); font-weight:600;">รวมทุกสี/ไซส์ · คงเหลือ ${totalQty} ชิ้น</div>
      </div>
    </div>
    <div class="detail-stats">
      <div class="detail-stat"><div class="lbl">ขายไปแล้วทั้งหมด (ทุกสี/ไซส์)</div><div class="val">${s.totalQtySold} ชิ้น</div></div>
      <div class="detail-stat"><div class="lbl">กำไรรวม (All time)</div><div class="val" style="color:${s.totalProfit < 0 ? "var(--red)" : "var(--green)"}">${fmtMoney(s.totalProfit)}</div></div>
    </div>
    ${renderMonthTable(s.months)}
    ${renderProductAds(prod.id)}
  `;
  wireProductAds();
  document.getElementById("detail-overlay").classList.add("show");
}
function closeDetail() {
  document.getElementById("detail-overlay").classList.remove("show");
}

// ---------- Edit modal ----------
function openEdit(variantId) {
  const found = findVariant(variantId);
  if (!found) return;
  editingVariantId = variantId;
  const { product, variant } = found;
  editingVariantSnapshot = JSON.stringify({ name: product.name, variant });
  const f = document.getElementById("edit-form");
  f.name.value = product.name;
  f.color.value = variant.color || "";
  f.size.value = variant.size || "";
  f.elements.namedItem("chestInches").value = variant.chestInches ?? "";
  f.elements.namedItem("lengthInches").value = variant.lengthInches ?? "";
  f.querySelectorAll('input[name="type"]').forEach(
    (r) => (r.checked = r.value === variant.type),
  );
  f.cost.value = variant.cost;
  f.price.value = variant.price;
  f.qty.value = variant.qty;
  f.elements.namedItem("reason").value = "แก้ไขจำนวนจากหน้าสินค้า";
  f.image.value = "";
  document.getElementById("edit-overlay").classList.add("show");
}
function closeEdit() {
  editingVariantId = null;
  editingVariantSnapshot = null;
  document.getElementById("edit-overlay").classList.remove("show");
}
document.getElementById("edit-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!editingVariantId) return;
  const f = e.target;
  const fd = new FormData(f);
  let image = null;
  const file = fd.get("image");
  if (file && file.size > 0) {
    try {
      image = await resizeImageFile(file);
    } catch (err) {
      console.error("image resize failed", err);
    }
  }
  const name = fd.get("name").trim();
  if (!name) {
    showAlert("กรุณาระบุชื่อสินค้า");
    return;
  }
  const saved = await editVariant(editingVariantId, {
    name,
    color: (fd.get("color") || "").trim(),
    size: (fd.get("size") || "").trim(),
    chestInches: parseMeasurement(fd.get("chestInches")),
    lengthInches: parseMeasurement(fd.get("lengthInches")),
    type: fd.get("type"),
    cost: parseFloat(fd.get("cost")),
    price: parseFloat(fd.get("price")),
    qty: Number(fd.get("qty")),
    reason: fd.get("reason"),
    image,
  });
  if (saved) closeEdit();
};

// ---------- Stock tab ----------
function measurementInputs(prefix) {
  return `<div class="measurement-fields"><label>อก (นิ้ว)<input type="number" class="${prefix}Chest" min="0.01" max="300" step="0.01" placeholder="ไม่ระบุ / เช่น 22.5"></label><label>ความยาว (นิ้ว)<input type="number" class="${prefix}Length" min="0.01" max="300" step="0.01" placeholder="ไม่ระบุ / เช่น 28"></label></div>`;
}
function readMeasurements(row, prefix) {
  return { chestInches: parseMeasurement(row.querySelector(`.${prefix}Chest`).value), lengthInches: parseMeasurement(row.querySelector(`.${prefix}Length`).value) };
}
function restockRowTemplate(options) {
  return `
    <div class="restock-row">
      <div class="restock-choice"><select class="restock-variant" aria-label="ตัวเลือกสินค้าเดิม">${options}</select><select class="restock-product" aria-label="สินค้าที่เพิ่มสีหรือไซส์" hidden>${products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select></div>
      <input type="number" class="restock-qty" min="1" value="1" placeholder="จำนวน">
      <input type="number" class="restock-row-cost" min="0" step="0.01" placeholder="ต้นทุน/ชิ้น">
      <input type="number" class="restock-row-price" min="0" step="0.01" placeholder="ราคาขาย (โน้ต)">
      <button type="button" class="btn-danger remove-restock-row" style="display:none;">×</button>
      <div class="restock-new-fields" hidden><input class="restock-color" placeholder="สีใหม่หรือสีเดิม" aria-label="สี"><input class="restock-size" placeholder="ไซส์ใหม่หรือไซส์เดิม" aria-label="ไซส์"><select class="restock-type" aria-label="สภาพสินค้า"><option value="new">มือหนึ่ง</option><option value="used">มือสอง</option></select>${measurementInputs("restock")}<span class="hint">สี/ไซส์/สภาพและขนาดจริงตรงกันจะเติมตัวเลือกเดิม หากอกหรือความยาวต่างกันจะแยกรายการ</span></div>
      <div class="restock-tools"><button type="button" class="btn btn-ghost btn-sm add-restock-option">+ เพิ่มสี / ไซส์ของสินค้านี้</button><span class="restock-mode-label hint"></span></div>
    </div>
  `;
}

function pendingRowTemplate(idx) {
  return `
    <div class="pending-row">
      <div class="pending-product-choice"><select class="pRowProduct" aria-label="เลือกสินค้าเดิมสำหรับสั่งซื้อ"><option value="">พิมพ์ชื่อสินค้า / สินค้าใหม่</option>${products.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}</select><button type="button" class="btn btn-ghost btn-sm add-pending-option">+ เพิ่มสี / ไซส์ของสินค้านี้</button></div>
      <div class="pending-row-grid">
        <input type="text" class="pRowName" list="product-name-list" placeholder="ชื่อสินค้า">
        <input type="text" class="pRowColor" placeholder="สี">
        <input type="text" class="pRowSize" placeholder="ไซส์">
        ${measurementInputs("pRow")}
        <div class="type-toggle pending-row-type">
          <label><input type="radio" name="pType_${idx}" value="new" checked><span>มือ1</span></label>
          <label><input type="radio" name="pType_${idx}" value="used"><span>มือ2</span></label>
        </div>
        <input type="number" class="pRowQty" min="1" placeholder="จำนวน">
        <input type="number" class="pRowCost" min="0" step="0.01" placeholder="ต้นทุน/ชิ้น">
        <input type="number" class="pRowPrice" min="0" step="0.01" placeholder="ราคาที่ตั้งใจขาย (โน้ต)">
        <button type="button" class="btn-danger remove-pending-row" style="display:none;">×</button>
      </div>
    </div>
  `;
}
function productBlockTemplate(idx) {
  return `
    <div class="product-block" data-block-idx="${idx}">
      <div class="form-grid">
        <div class="field" style="grid-column:span 2">
          <label>ชื่อสินค้า</label>
          <input type="text" class="pb-name" list="product-name-list" placeholder="เช่น เสื้อยืดลายกราฟฟิก">
        </div>
        <div class="field">
          <label>ประเภทสินค้า</label>
          <div class="type-toggle pb-type-toggle">
            <label><input type="radio" name="pbType_${idx}" value="new" checked><span>มือ1</span></label>
            <label><input type="radio" name="pbType_${idx}" value="used"><span>มือ2</span></label>
          </div>
        </div>
        <div class="field">
          <label>รูปสินค้า (ถ้ามี)</label>
          <input type="file" class="pb-image" accept="image/*">
        </div>
        <div class="field" style="grid-column:span 2">
          <label>สี ไซส์ และจำนวน (เพิ่มได้หลายไซส์ของสินค้านี้)</label>
          <div class="pb-size-rows">
            <div class="pb-size-row">
              <input type="text" class="pbRowColor" placeholder="สี เช่น ดำ">
              <input type="text" class="pbRowSize" placeholder="ไซส์ เช่น S">
              ${measurementInputs("pbRow")}
              <input type="number" class="pbRowQty" min="1" placeholder="จำนวน">
              <button type="button" class="btn-danger remove-pb-size-row" style="display:none;">×</button>
            </div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm add-pb-size-row" style="margin-top:4px;">+ เพิ่มไซส์อีก</button>
        </div>
        <div class="field">
          <label>ราคาที่ตั้งใจขาย/ชิ้น (โน้ต)</label>
          <input type="number" class="pb-price" min="0" step="0.01">
        </div>
        <div class="pb-cost-block" style="display:contents;">
          <div class="field" style="grid-column:span 2">
            <label>วิธีคิดต้นทุนของสินค้านี้</label>
            <div class="type-toggle pb-cost-mode-toggle">
              <label><input type="radio" name="pbCostMode_${idx}" value="perunit" checked><span>ต่อชิ้น</span></label>
              <label><input type="radio" name="pbCostMode_${idx}" value="lump"><span>เหมาทั้งล็อตของสินค้านี้</span></label>
            </div>
          </div>
          <div class="field pb-cost-perunit-field">
            <label>ต้นทุน/ชิ้น</label>
            <input type="number" class="pb-cost-perunit" min="0" step="0.01">
          </div>
          <div class="field pb-cost-lump-field" style="display:none;">
            <label>ยอดที่จ่ายทั้งล็อตของสินค้านี้ (ทุกไซส์รวมกัน)</label>
            <input type="number" class="pb-cost-lump" min="0" step="0.01">
          </div>
        </div>
      </div>
      <div style="margin-top:8px; text-align:right;">
        <button type="button" class="btn-danger remove-product-block" style="display:none;">ลบสินค้านี้ออกจากรายการ</button>
      </div>
    </div>
  `;
}

function renderMeasurementDetails(variant) {
  return `<span class="size-measurements" aria-label="ขนาดจริงของตัวเลือกนี้"><span>อก ${variant.chestInches == null ? "ยังไม่ระบุ" : escapeHtml(variant.chestInches) + " นิ้ว"}</span><span>ยาว ${variant.lengthInches == null ? "ยังไม่ระบุ" : escapeHtml(variant.lengthInches) + " นิ้ว"}</span></span>`;
}

function renderStockRows(groups) {
  return groups
    .map((group) => {
      const totalQty = group.variants.reduce(
        (sum, { variant }) => sum + variant.qty,
        0,
      );
      const totalValue = group.variants.reduce(
        (sum, { variant }) => sum + variant.cost * variant.qty,
        0,
      );
      const averageCost = totalQty ? totalValue / totalQty : 0;
      const sizeRows = group.variants
        .map(({ variant: v }) => {
          const isSoldOut = v.qty <= 0;
          return `
      <div class="stock-size-item ${isSoldOut ? "soldout-item" : ""}" data-stock-variant="${escapeHtml(v.id)}">
        <span>ไซส์ ${escapeHtml(v.size || "-")} · ${v.type === "new" ? "มือ1" : "มือ2"} · ${isSoldOut ? "สินค้าหมด" : v.qty + " ชิ้น"}${renderMeasurementDetails(v)}</span>
        <span>${fmtMoney(v.cost)}</span>
        <button class="btn btn-ghost btn-sm" data-edit="${v.id}">แก้ไข</button>
        <button class="btn-danger" data-del="${v.id}">ลบ</button>
      </div>`;
        })
        .join("");
      return `
    <tr>
      <td><div class="thumb-cell">
        <div class="thumb">${group.image ? `<img src="${escapeHtml(group.image)}" alt="">` : '<span class="thumb-ph">👕</span>'}</div>
      </div></td>
      <td>${escapeHtml(group.name)}<div class="stock-ad-actions">${[...new Map(group.variants.map(({product}) => [product.id, product])).values()].map(product => `<button class="btn btn-ghost btn-sm" data-product-ads="${escapeHtml(product.id)}">ยิงแอด (${adCampaigns.filter(c => campaignHasProduct(c, product.id)).length})</button>`).join("")}</div></td>
      <td>${escapeHtml(group.color)}</td>
      <td class="stock-size-list">${sizeRows}</td>
      <td class="num">${totalQty}</td>
      <td class="num">${fmtMoney(averageCost)}</td>
      <td class="num">${fmtMoney(totalValue)}</td>
    </tr>`;
    })
    .join("");
}

function renderStockTab() {
  const groups = stockColorGroups();
  const splitGroups = (inStock) =>
    groups
      .map((group) => ({
        ...group,
        variants: group.variants.filter(({ variant }) =>
          inStock ? variant.qty > 0 : variant.qty <= 0,
        ),
      }))
      .filter((group) => group.variants.length > 0);
  const availableGroups = splitGroups(true);
  const soldOutGroups = splitGroups(false);
  const stockSection = (key, title, sectionGroups) => `
    <section class="stock-section" data-stock-section="${key}" aria-labelledby="stock-heading-${key}">
      <h3 id="stock-heading-${key}">${title}<span class="stock-section-count">${sectionGroups.length} กลุ่มสินค้า</span></h3>
      <table>
        <thead><tr>
          <th></th><th>ชื่อสินค้า</th><th>สี</th><th>ไซส์ / รายละเอียด</th><th class="num">คงเหลือรวม</th><th class="num">ต้นทุนเฉลี่ย</th><th class="num">มูลค่าคงเหลือ</th>
        </tr></thead>
        <tbody>${renderStockRows(sectionGroups)}</tbody>
      </table>
    </section>`;

  const productNameOptions = products
    .map((p) => `<option value="${escapeHtml(p.name)}">`)
    .join("");

  const variantOptions = allVariants()
    .map(
      ({ product: p, variant: v }) =>
        `<option value="${v.id}">${escapeHtml(variantLabel(p, v))} — คงเหลือ ${v.qty}</option>`,
    )
    .join("");

  return `
    <div class="panel">
      <h2>เพิ่มสินค้าเข้าสต็อก</h2>
      <form id="add-product-form" novalidate>
        <div class="type-toggle" id="mode-toggle" style="max-width:520px; margin-bottom:16px;">
          <label><input type="radio" name="mode" value="new" checked><span>เพิ่มสินค้า/ตัวเลือกใหม่</span></label>
          <label><input type="radio" name="mode" value="restock" ${allVariants().length === 0 ? "disabled" : ""}><span>เติมสต็อก / เพิ่มสีไซส์</span></label>
          <label><input type="radio" name="mode" value="pending"><span>สั่งซื้อ (จ่ายแล้ว รอของมาส่ง)</span></label>
        </div>

        <div id="new-item-fields" class="form-grid">
          <datalist id="product-name-list">${productNameOptions}</datalist>
          <div class="field" style="grid-column:1/-1">
            <label>วิธีคิดต้นทุนโดยรวม</label>
            <div class="type-toggle" id="global-cost-mode-toggle">
              <label><input type="radio" name="globalCostMode" value="perproduct" checked><span>แยกคิดต้นทุนแต่ละสินค้า</span></label>
              <label><input type="radio" name="globalCostMode" value="lumpall"><span>เหมารวมทุกสินค้าในครั้งนี้เป็นยอดเดียว</span></label>
            </div>
          </div>
          <div class="field" id="lump-all-field" style="display:none; grid-column:1/-1;">
            <label>ยอดที่จ่ายทั้งหมด (ทุกสินค้า ทุกไซส์ ทุกชิ้น ในครั้งนี้รวมกัน)</label>
            <input type="number" id="lumpAllCost" min="0" step="0.01">
          </div>

          <div id="product-blocks" style="grid-column:1/-1; display:flex; flex-direction:column; gap:14px;">
            ${productBlockTemplate(0)}
          </div>
          <div style="grid-column:1/-1;">
            <button type="button" class="btn btn-ghost btn-sm" id="add-product-block">+ เพิ่มสินค้าอีกตัว (คนละชื่อ)</button>
          </div>

          <div class="field">
            <label>ค่าส่งจากต้นทาง (รวมทั้งครั้งนี้)</label>
            <input type="number" name="shippingIn" min="0" step="0.01" value="0">
          </div>
          <div class="checkline">
            <input type="checkbox" name="logExpense" id="logExpense" checked>
            <label for="logExpense">บันทึกต้นทุนที่ซื้อเข้าเป็นรายจ่ายทันที</label>
          </div>
          <p class="hint" style="grid-column:1/-1; margin:2px 0 0;">แต่ละสินค้าตั้งชื่อของตัวเอง แล้วเพิ่มสี/ไซส์ได้หลายแถว สินค้ามือสองที่ขนาดต่างกันให้แยกแถวและกรอกอก/ความยาวหน่วยนิ้ว เช่น ไซส์ M อก 22 ยาว 28 กับไซส์ M อก 23 ยาว 29 — เลือกได้ว่าจะคิดต้นทุนแยกทีละสินค้า (ต่อชิ้น หรือเหมาทั้งล็อตของสินค้านั้น) หรือจะเหมารวมทุกสินค้าทุกไซส์ในครั้งนี้เป็นยอดเดียวแล้วให้ระบบหารเฉลี่ยต้นทุนต่อชิ้นให้เอง</p>
        </div>

        <div id="restock-fields" class="form-grid" style="display:none;">
          <div class="field" style="grid-column:1/-1">
            <label>รายการที่เติมสต๊อก (เลือกได้หลายสินค้า)</label>
            <div class="restock-row restock-heading" aria-hidden="true"><span>สินค้า</span><span>จำนวน</span><span>ต้นทุน/ชิ้น</span><span>ราคาขาย (โน้ต)</span></div>
            <div id="restock-rows">${restockRowTemplate(variantOptions)}</div>
            <button type="button" class="btn btn-ghost btn-sm" id="add-restock-row" style="margin-top:4px;">+ เพิ่มรายการเติมสต็อก</button>
            <p class="hint">เลือกตัวเลือกเดิมเพื่อเติมจำนวน หรือกด “เพิ่มสี / ไซส์ของสินค้านี้” เพื่อเพิ่มตัวเลือกใหม่โดยไม่ต้องสร้างสินค้าใหม่</p>
          </div>
          <div class="field">
            <label>วิธีคิดต้นทุน</label>
            <div class="type-toggle" id="restock-cost-mode-toggle">
              <label><input type="radio" name="restockCostMode" value="perunit" checked><span>รายชิ้น</span></label>
              <label><input type="radio" name="restockCostMode" value="lump"><span>เหมาทั้งล็อต</span></label>
            </div>
          </div>
          <div class="field" id="restock-lump-field" style="display:none;">
            <label>ยอดต้นทุนทั้งล็อต (ทุกรายการรวมกัน)</label>
            <input type="number" name="restockLumpCost" min="0" step="0.01">
          </div>
          <div class="field">
            <label>ค่าส่งจากต้นทาง (ทั้งล็อต)</label>
            <input type="number" name="restockShippingIn" min="0" step="0.01" value="0">
          </div>
          <div class="checkline">
            <input type="checkbox" name="restockLogExpense" id="restockLogExpense" checked>
            <label for="restockLogExpense">บันทึกต้นทุนที่เติมเข้าเป็นรายจ่ายทันที</label>
          </div>
          <p class="hint" style="grid-column:1/-1; margin:2px 0 0;">เลือกได้หลายตัวในครั้งเดียว: แบบรายชิ้นให้กรอกต้นทุนแต่ละแถว; แบบเหมาทั้งล็อตระบบจะหารต้นทุนเฉลี่ยตามจำนวนรวมให้เอง ค่าส่งจะบันทึกเป็นรายจ่ายแยกต่างหาก</p>
        </div>

        <div id="pending-fields" class="form-grid" style="display:none;">
          <div class="field" style="grid-column:1/-1">
            <label>วิธีคิดต้นทุน</label>
            <div class="type-toggle" id="pending-cost-mode-toggle">
              <label><input type="radio" name="pendingCostMode" value="perunit" checked><span>ต่อชิ้น (ใส่ในแต่ละแถว)</span></label>
              <label><input type="radio" name="pendingCostMode" value="lump"><span>เหมาทั้งล็อต (ยอดเดียวทั้งออเดอร์)</span></label>
            </div>
          </div>
          <div class="field" style="grid-column:1/-1">
            <label>รายการสินค้าที่สั่ง (เพิ่มได้หลายสี/หลายสินค้าในออเดอร์เดียวกัน)</label>
            <div id="pending-rows">${pendingRowTemplate(0)}</div>
            <button type="button" class="btn btn-ghost btn-sm" id="add-pending-row" style="margin-top:6px;">+ เพิ่มรายการสินค้า</button>
          </div>
          <div class="field" id="pending-lump-field" style="display:none; grid-column:span 2;">
            <label>ยอดที่จ่ายทั้งหมด (ทุกรายการในออเดอร์นี้รวมกัน)</label>
            <input type="number" name="pendingLumpCost" min="0" step="0.01">
          </div>
          <div class="field" style="grid-column:span 2">
            <label>บันทึกเพิ่มเติม (เช่น เลขคำสั่งซื้อ, ร้านที่สั่ง) — ใช้ร่วมทั้งออเดอร์</label>
            <input type="text" name="pendingNote" placeholder="ไม่บังคับ">
          </div>
          <p class="hint" style="grid-column:1/-1; margin:2px 0 0;">ใช้ตอนโอนเงินจ่ายค่าสินค้าไปแล้วแต่ของยังไม่ถึงร้าน ระบบจะรวมยอดทุกรายการเป็นรายจ่าย 1 ก้อนทันที แต่ยัง<strong>ไม่เพิ่มเข้าสต็อก</strong>จนกว่าจะกด "ยืนยันได้รับของแล้ว" ทีละรายการ — ถ้าเลือก "เหมาทั้งล็อต" ระบบจะหารเฉลี่ยต้นทุนต่อชิ้นตามสัดส่วนจำนวนให้เอง — ค่าส่งจะยังไม่ถูกบันทึก จนกว่าจะจ่ายจริงตอนได้รับของ</p>
        </div>

        <div style="margin-top:12px;"><button type="submit" class="btn btn-primary" id="add-product-submit">เพิ่มสินค้า</button></div>
      </form>
    </div>

    <div class="panel">
      <h2>สินค้าที่สั่งซื้อแล้ว รอรับของ${pendingOrders.length > 0 ? " (" + pendingOrders.length + ")" : ""}</h2>
      <p class="hint">รายการนี้จ่ายเงินไปแล้ว (นับเป็นรายจ่ายแล้ว) แต่ยังไม่นับเป็นสต็อกที่ขายได้ จนกว่าจะกดยืนยันว่าได้รับของจริง — ติ๊กเลือกรายการที่ของมาถึงพร้อมกัน ระบุจำนวนที่ได้รับครั้งนี้ได้แม้มาไม่ครบ แล้วใส่ค่าส่งรวมครั้งเดียวได้</p>
      ${
        pendingOrders.length === 0
          ? `<div class="empty"><div class="big">ไม่มีรายการรอรับของ</div></div>`
          : `
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${pendingOrders
          .map(
            (po) => `
          <div class="variant-row" style="align-items:center;">
            <input type="checkbox" class="pending-select" data-pending-id="${po.id}" style="width:18px; height:18px; accent-color: var(--navy); flex-shrink:0;">
            <div class="thumb" style="width:36px;height:36px;">${po.image ? `<img src="${escapeHtml(po.image)}" alt="">` : '<span class="thumb-ph">📦</span>'}</div>
            <div class="variant-info">
              ${escapeHtml(pendingLabel(po))} x${po.qty}<br>
              <span class="hint" style="margin:0;">สั่งเมื่อ ${po.orderDate} · ต้นทุนส่วนที่รอรับ ${fmtMoney(po.cost * po.qty)}${po.receivedQty ? " · รับแล้ว " + po.receivedQty + "/" + po.originalQty + " ชิ้น" : ""}${po.note ? " · " + escapeHtml(po.note) : ""}</span>
            </div>
            <div class="field pending-receive-field"><label>รับครั้งนี้ (ชิ้น)</label><input class="pending-receive-qty" data-pending-id="${escapeHtml(po.id)}" type="number" min="1" max="${po.qty}" step="1" value="${po.qty}" aria-label="จำนวนรับ ${escapeHtml(po.name)}"></div>
            <button class="btn-danger" data-cancel-pending="${po.id}">ยกเลิก</button>
          </div>
        `,
          )
          .join("")}
      </div>
      <div class="form-grid" style="margin-top:14px; grid-template-columns:1fr 1fr;">
        <div class="field">
          <label>ค่าส่งรวม (สำหรับรายการที่ติ๊กเลือก)</label>
          <input type="number" id="pending-bulk-ship" min="0" step="0.01" value="0">
        </div>
      </div>
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost btn-sm" id="pending-select-all">เลือกทั้งหมด</button>
        <button class="btn btn-gold" id="pending-receive-selected">ยืนยันได้รับของที่เลือกแล้ว</button>
      </div>
      `
      }
    </div>

    <div class="panel">
      <h2>แนบค่าส่งให้สินค้าหลายชิ้น</h2>
      <p class="hint">ใช้ตอนจ่ายค่าส่งเหมาทั้งล็อตให้หลายสินค้าพร้อมกัน (ไม่ต้องแยกจ่ายรายชิ้น) เลือกสินค้าที่มาในล็อตนี้พร้อมจำนวน แล้วใส่ยอดค่าส่งรวม ระบบจะบันทึกเป็นรายจ่าย 1 รายการ แนบไว้กับสินค้าที่เลือกทั้งหมด</p>
      <div class="field" style="margin-bottom:10px;">
        <input type="text" id="attach-ship-search" placeholder="ค้นหาสินค้าที่จะแนบ...">
      </div>
      ${
        allVariants().length === 0
          ? `<div class="empty"><div class="big">ยังไม่มีสินค้าในสต็อกให้แนบค่าส่ง</div></div>`
          : `
      <div id="attach-ship-list" style="max-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;">
        ${stockColorGroups()
          .map((group, gi) => {
            const sortedVariants = [...group.variants].sort((a, b) =>
              compareSizes(a.variant.size, b.variant.size),
            );
            const sizeOptions = sortedVariants
              .map(
                ({ variant: v }) =>
                  `<option value="${v.id}">ไซส์ ${escapeHtml(v.size || "-")} · ${v.type === "used" ? "มือ2" : "มือ1"} ${measurementLabel(v) ? ` · ${escapeHtml(measurementLabel(v))}` : ""} · เหลือ ${v.qty}</option>`,
              )
              .join("");
            const first = sortedVariants[0].variant;
            return `
          <div class="variant-row shipping-row" data-attach-row="${gi}" data-attach-label="${escapeHtml(group.name + " " + group.color).toLowerCase()}">
            <div class="variant-info"><strong>${escapeHtml(group.name)}</strong><span class="shipping-color">${escapeHtml(group.color)}</span></div>
            <div class="field shipping-size-field"><label for="attach-size-${gi}">ไซส์ / สภาพสินค้า</label><select id="attach-size-${gi}" class="attach-size-select" aria-label="ไซส์ของ ${escapeHtml(group.name + " " + group.color)}">${sizeOptions}</select></div>
            <div class="field shipping-qty-field"><label for="attach-qty-${gi}">จำนวนชิ้น</label><input id="attach-qty-${gi}" type="number" min="0" max="${first.qty}" value="0" class="attach-qty" data-variant="${first.id}" aria-label="จำนวน ${escapeHtml(group.name + " " + group.color)}"></div>
          </div>
        `;
          })
          .join("")}
      </div>
      <div class="form-grid" style="margin-top:14px; grid-template-columns:1fr 1fr;">
        <div class="field">
          <label>ยอดค่าส่งรวมทั้งหมด</label>
          <input type="number" id="attach-ship-amount" min="0" step="0.01">
        </div>
        <div class="field">
          <label>วันที่</label>
          <input type="date" id="attach-ship-date" value="${todayStr()}">
        </div>
      </div>
      <div style="margin-top:12px;"><button class="btn btn-primary" id="attach-ship-submit">บันทึกค่าส่ง</button></div>
      `
      }
    </div>

    <div class="panel">
      <div class="panel-title-action">
        <div><h2>รายการสินค้าในสต็อก</h2><p class="hint">รวมรายการชื่อและสีเดียวกันไว้ในแถวเดียว เลือกแก้ไขรายไซส์ได้</p></div>
        <button class="btn btn-ghost btn-sm" id="merge-data-btn">Merge ข้อมูลซ้ำ</button>
      </div>
      ${
        allVariants().length === 0
          ? `
        <div class="empty">
          <div class="big">ยังไม่มีสินค้าในสต็อก</div>
          เพิ่มสินค้าชิ้นแรกจากฟอร์มด้านบน
        </div>`
          : `${availableGroups.length ? stockSection("available", "สินค้าพร้อมขาย", availableGroups) : ""}
             ${soldOutGroups.length ? stockSection("soldout", "สินค้าหมด", soldOutGroups) : ""}`
      }
    </div>
  `;
}

function wireStockTab() {
  const f = document.getElementById("add-product-form");
  const newFields = document.getElementById("new-item-fields");
  const restockFields = document.getElementById("restock-fields");
  const pendingFields = document.getElementById("pending-fields");
  const submitBtn = document.getElementById("add-product-submit");
  const modeToggle = document.getElementById("mode-toggle");

  if (modeToggle) {
    modeToggle.querySelectorAll('input[name="mode"]').forEach((r) => {
      r.onchange = () => {
        if (r.checked) {
          newFields.style.display = r.value === "new" ? "grid" : "none";
          restockFields.style.display = r.value === "restock" ? "grid" : "none";
          pendingFields.style.display = r.value === "pending" ? "grid" : "none";
          submitBtn.textContent =
            r.value === "restock"
              ? "เติมสต็อก"
              : r.value === "pending"
                ? "บันทึกรายการสั่งซื้อ"
                : "เพิ่มสินค้า";
        }
      };
    });
    wireToggleLabels(modeToggle);
  }
  // robust click handling for all other type-toggle radio groups on this tab
  document
    .querySelectorAll(
      "#new-item-fields .type-toggle, #pending-fields .type-toggle",
    )
    .forEach(wireToggleLabels);

  // --- restock rows (multiple existing variants in one batch) ---
  const restockRowsDiv = document.getElementById("restock-rows");
  const restockOptions =
    document.querySelector("#restock-rows .restock-variant")?.innerHTML || "";
  function syncRestockRow(row) {
    const found = findVariant(row.querySelector(".restock-variant").value);
    if (!found) return;
    row.querySelector(".restock-row-cost").value = found.variant.cost;
    row.querySelector(".restock-row-price").value = found.variant.price;
  }
  function wireRestockRows() {
    if (!restockRowsDiv) return;
    const rows = restockRowsDiv.querySelectorAll(".restock-row");
    rows.forEach((row) => {
      const remove = row.querySelector(".remove-restock-row");
      remove.style.display = rows.length > 1 ? "inline-flex" : "none";
      remove.onclick = () => {
        row.remove();
        wireRestockRows();
      };
      row.querySelector(".restock-variant").onchange = () => syncRestockRow(row);
      row.querySelector(".add-restock-option").onclick = () => {
        const found = findVariant(row.querySelector(".restock-variant").value);
        const wrapper = document.createElement("div");
        wrapper.innerHTML = restockRowTemplate(restockOptions);
        const next = wrapper.firstElementChild;
        next.dataset.newOption = "true";
        next.dataset.initialized = "true";
        next.querySelector(".restock-variant").hidden = true;
        next.querySelector(".restock-product").hidden = false;
        next.querySelector(".restock-product").value = row.dataset.newOption ? row.querySelector(".restock-product").value : found?.product.id || "";
        next.querySelector(".restock-new-fields").hidden = false;
        next.querySelector(".restock-mode-label").textContent = "เพิ่มสี / ไซส์ให้สินค้าเดิม";
        next.querySelector(".restock-color").value = row.dataset.newOption ? row.querySelector(".restock-color").value : found?.variant.color || "";
        next.querySelector(".restock-type").value = row.dataset.newOption ? row.querySelector(".restock-type").value : found?.variant.type || "new";
        next.querySelector(".restock-row-cost").value = row.querySelector(".restock-row-cost").value;
        next.querySelector(".restock-row-price").value = row.querySelector(".restock-row-price").value;
        row.after(next);
        wireRestockRows();
        enhanceUI();
        next.querySelector(".restock-size").focus();
      };
      if (!row.dataset.initialized) { syncRestockRow(row); row.dataset.initialized = "true"; }
    });
  }
  const addRestockRowBtn = document.getElementById("add-restock-row");
  if (addRestockRowBtn)
    addRestockRowBtn.onclick = () => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = restockRowTemplate(restockOptions);
      restockRowsDiv.appendChild(wrapper.firstElementChild);
      wireRestockRows();
    };
  wireRestockRows();
  const restockCostModeToggle = document.getElementById(
    "restock-cost-mode-toggle",
  );
  const restockLumpField = document.getElementById("restock-lump-field");
  if (restockCostModeToggle) {
    wireToggleLabels(restockCostModeToggle);
    restockCostModeToggle
      .querySelectorAll('input[name="restockCostMode"]')
      .forEach(
        (r) =>
          (r.onchange = () => {
            if (!r.checked) return;
            const isLump = r.value === "lump";
            restockLumpField.style.display = isLump ? "flex" : "none";
            restockRowsDiv.classList.toggle("lump-mode", isLump);
          }),
      );
  }
  // --- product blocks (multi-product add, each with its own name & sizes) ---
  const globalCostModeToggle = document.getElementById(
    "global-cost-mode-toggle",
  );
  const lumpAllField = document.getElementById("lump-all-field");
  function applyGlobalCostModeVisibility() {
    const mode =
      document.querySelector(
        '#global-cost-mode-toggle input[name="globalCostMode"]:checked',
      )?.value || "perproduct";
    const isLumpAll = mode === "lumpall";
    if (lumpAllField) lumpAllField.style.display = isLumpAll ? "flex" : "none";
    document
      .querySelectorAll("#product-blocks .pb-cost-block")
      .forEach((el) => {
        el.style.display = isLumpAll ? "none" : "contents";
      });
  }
  if (globalCostModeToggle) {
    wireToggleLabels(globalCostModeToggle);
    globalCostModeToggle
      .querySelectorAll('input[name="globalCostMode"]')
      .forEach((r) => {
        r.onchange = () => {
          if (r.checked) applyGlobalCostModeVisibility();
        };
      });
  }

  function updateRemoveBlockButtons() {
    const blocksDiv = document.getElementById("product-blocks");
    if (!blocksDiv) return;
    const blocks = blocksDiv.querySelectorAll(".product-block");
    blocks.forEach((block) => {
      const btn = block.querySelector(".remove-product-block");
      if (btn) btn.style.display = blocks.length > 1 ? "inline-block" : "none";
    });
  }

  function wireProductBlock(block) {
    wireToggleLabels(block.querySelector(".pb-type-toggle"));
    const costModeToggle = block.querySelector(".pb-cost-mode-toggle");
    wireToggleLabels(costModeToggle);
    const perunitField = block.querySelector(".pb-cost-perunit-field");
    const lumpField = block.querySelector(".pb-cost-lump-field");
    costModeToggle.querySelectorAll("input").forEach((r) => {
      r.onchange = () => {
        if (!r.checked) return;
        const isLump = r.value === "lump";
        perunitField.style.display = isLump ? "none" : "flex";
        lumpField.style.display = isLump ? "flex" : "none";
      };
    });

    function wirePbSizeRemoveButtons() {
      const rowsDiv = block.querySelector(".pb-size-rows");
      const buttons = rowsDiv.querySelectorAll(".remove-pb-size-row");
      buttons.forEach((btn) => {
        btn.style.display = buttons.length > 1 ? "inline-flex" : "none";
        btn.onclick = () => {
          if (rowsDiv.children.length > 1) btn.closest(".pb-size-row").remove();
          wirePbSizeRemoveButtons();
        };
      });
    }
    wirePbSizeRemoveButtons();

    const addRowBtn = block.querySelector(".add-pb-size-row");
    if (addRowBtn) {
      addRowBtn.onclick = () => {
        const rowsDiv = block.querySelector(".pb-size-rows");
        const row = document.createElement("div");
        row.className = "pb-size-row";
        row.innerHTML = `
          <input type="text" class="pbRowColor" placeholder="สี เช่น ขาว">
          <input type="text" class="pbRowSize" placeholder="ไซส์ เช่น M">
          ${measurementInputs("pbRow")}
          <input type="number" class="pbRowQty" min="1" placeholder="จำนวน">
          <button type="button" class="btn-danger remove-pb-size-row">×</button>
        `;
        rowsDiv.appendChild(row);
        wirePbSizeRemoveButtons();
      };
    }

    const removeBlockBtn = block.querySelector(".remove-product-block");
    if (removeBlockBtn) {
      removeBlockBtn.onclick = () => {
        const blocksDiv = document.getElementById("product-blocks");
        if (blocksDiv.children.length > 1) block.remove();
        updateRemoveBlockButtons();
      };
    }
  }

  let productBlockSeq = 1;
  document
    .querySelectorAll("#product-blocks .product-block")
    .forEach(wireProductBlock);
  updateRemoveBlockButtons();
  applyGlobalCostModeVisibility();

  const addProductBlockBtn = document.getElementById("add-product-block");
  if (addProductBlockBtn) {
    addProductBlockBtn.onclick = () => {
      const blocksDiv = document.getElementById("product-blocks");
      const wrapper = document.createElement("div");
      wrapper.innerHTML = productBlockTemplate(productBlockSeq++);
      const newBlock = wrapper.firstElementChild;
      blocksDiv.appendChild(newBlock);
      wireProductBlock(newBlock);
      updateRemoveBlockButtons();
      applyGlobalCostModeVisibility();
    };
  }

  // --- pending order rows (add/remove) ---
  let pendingRowSeq = 1;
  function wirePendingRemoveButtons() {
    const rowsDiv = document.getElementById("pending-rows");
    if (!rowsDiv) return;
    rowsDiv.querySelectorAll(".pending-row").forEach(row => {
      const select = row.querySelector(".pRowProduct"), name = row.querySelector(".pRowName");
      select.onchange = () => {
        const product = products.find(p => p.id === select.value);
        if (product) name.value = product.name;
        name.readOnly = Boolean(product);
      };
      row.querySelector(".add-pending-option").onclick = () => {
        if (!name.value.trim()) { showAlert("เลือกสินค้าเดิมหรือกรอกชื่อสินค้าก่อนเพิ่มสี/ไซส์"); return; }
        const wrapper = document.createElement("div");
        wrapper.innerHTML = pendingRowTemplate(pendingRowSeq++);
        const next = wrapper.firstElementChild;
        [".pRowProduct", ".pRowName", ".pRowColor", ".pRowCost", ".pRowPrice"].forEach(selector => { next.querySelector(selector).value = row.querySelector(selector).value; });
        next.querySelector(".pRowName").readOnly = name.readOnly;
        const type = row.querySelector('.pending-row-type input:checked').value;
        next.querySelector(`.pending-row-type input[value="${type}"]`).checked = true;
        row.after(next);
        wireToggleLabels(next.querySelector(".pending-row-type"));
        wirePendingRemoveButtons(); enhanceUI();
        next.querySelector(".pRowSize").focus();
      };
    });
    const buttons = rowsDiv.querySelectorAll(".remove-pending-row");
    buttons.forEach((btn) => {
      btn.style.display = buttons.length > 1 ? "inline-flex" : "none";
      btn.onclick = () => {
        if (rowsDiv.children.length > 1) btn.closest(".pending-row").remove();
        wirePendingRemoveButtons();
      };
    });
  }
  const addPendingRowBtn = document.getElementById("add-pending-row");
  if (addPendingRowBtn) {
    addPendingRowBtn.onclick = () => {
      const rowsDiv = document.getElementById("pending-rows");
      const wrapper = document.createElement("div");
      wrapper.innerHTML = pendingRowTemplate(pendingRowSeq++);
      const newRow = wrapper.firstElementChild;
      rowsDiv.appendChild(newRow);
      wireToggleLabels(newRow.querySelector(".pending-row-type"));
      wirePendingRemoveButtons();
    };
    wirePendingRemoveButtons();
  }

  // --- pending order cost mode toggle (per-unit vs lump sum for whole order) ---
  const pendingCostModeToggle = document.getElementById(
    "pending-cost-mode-toggle",
  );
  const pendingLumpField = document.getElementById("pending-lump-field");
  const pendingRowsDiv = document.getElementById("pending-rows");
  if (pendingCostModeToggle) {
    pendingCostModeToggle
      .querySelectorAll('input[name="pendingCostMode"]')
      .forEach((r) => {
        r.onchange = () => {
          if (r.checked) {
            const isLump = r.value === "lump";
            pendingLumpField.style.display = isLump ? "flex" : "none";
            if (pendingRowsDiv)
              pendingRowsDiv.classList.toggle("lump-mode", isLump);
          }
        };
      });
  }

  // --- cost mode toggle ---
  const costModeToggle = document.getElementById("cost-mode-toggle");
  const costPerunitField = document.getElementById("cost-perunit-field");
  const costLumpField = document.getElementById("cost-lump-field");
  if (costModeToggle) {
    costModeToggle.querySelectorAll('input[name="costMode"]').forEach((r) => {
      r.onchange = () => {
        if (r.checked) {
          const isLump = r.value === "lump";
          costPerunitField.style.display = isLump ? "none" : "flex";
          costLumpField.style.display = isLump ? "flex" : "none";
        }
      };
    });
  }

  if (f)
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (submitBtn.dataset.saving === "true") return;
      const originalSubmitText = submitBtn.textContent;
      submitBtn.dataset.saving = "true";
      submitBtn.disabled = true;
      submitBtn.textContent = "กำลังบันทึก...";
      try {
        const fd = new FormData(f);
        const mode = fd.get("mode");
        if (mode === "restock") {
          const costMode = fd.get("restockCostMode") || "perunit";
          const rows = [];
          const selected = new Set();
          let rowError = null;
          document
            .querySelectorAll("#restock-rows .restock-row")
            .forEach((row, i) => {
              const newOption = row.dataset.newOption === "true";
              const variantId = newOption ? "" : row.querySelector(".restock-variant").value;
              const productId = newOption ? row.querySelector(".restock-product").value : "";
              const qty = Number(row.querySelector(".restock-qty").value);
              const costValue = row.querySelector(".restock-row-cost").value;
              const priceValue = row.querySelector(".restock-row-price").value;
              if ((!newOption && !variantId) || (newOption && !productId) || !Number.isSafeInteger(qty) || qty < 1) {
                rowError = "ระบุสินค้าและจำนวนให้ถูกต้องในแถวที่ " + (i + 1);
                return;
              }
              if (!newOption && selected.has(variantId)) {
                rowError =
                  "เลือกสินค้าซ้ำในแถวที่ " +
                  (i + 1) +
                  " กรุณารวมจำนวนไว้ในแถวเดียว";
                return;
              }
              if (!newOption) selected.add(variantId);
              const cost = parseFloat(costValue);
              if (costMode === "perunit" && (isNaN(cost) || cost < 0)) {
                rowError = "กรุณาระบุต้นทุนต่อชิ้นในแถวที่ " + (i + 1);
                return;
              }
              const price = parseFloat(priceValue);
              rows.push({
                newOption, productId,
                ...(newOption ? readMeasurements(row, "restock") : {}),
                color: newOption ? row.querySelector(".restock-color").value.trim() : "",
                size: newOption ? row.querySelector(".restock-size").value.trim() : "",
                type: newOption ? row.querySelector(".restock-type").value : "new",
                variantId,
                qty,
                cost,
                price: isNaN(price) ? null : price,
              });
            });
          if (rowError) {
            showAlert(rowError);
            return;
          }
          if (rows.length === 0) {
            showAlert("กรุณาเลือกรายการที่จะเติมสต๊อกอย่างน้อย 1 รายการ");
            return;
          }
          if (costMode === "lump") {
            const lumpCost = parseFloat(fd.get("restockLumpCost"));
            if (isNaN(lumpCost) || lumpCost < 0) {
              showAlert("กรุณาระบุยอดต้นทุนทั้งล็อตให้ถูกต้อง");
              return;
            }
            const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
            rows.forEach((row) => {
              row.cost = lumpCost / totalQty;
            });
          }
          await restockVariants(rows, {
            logExpense: fd.get("restockLogExpense") === "on",
            shippingIn: parseFloat(fd.get("restockShippingIn")) || 0,
          });
        } else if (mode === "pending") {
          const pendingCostMode = fd.get("pendingCostMode") || "perunit";
          const rowEls = document.querySelectorAll(
            "#pending-rows .pending-row",
          );
          const rows = [];
          let rowError = null;
          rowEls.forEach((rowEl, i) => {
            const productId = rowEl.querySelector(".pRowProduct").value;
            const selectedProduct = products.find(p => p.id === productId);
            if (productId && !selectedProduct) { rowError = "สินค้าเดิมถูกลบ กรุณาเลือกสินค้าอีกครั้ง"; return; }
            const name = selectedProduct?.name || rowEl.querySelector(".pRowName").value.trim();
            const qtyStr = rowEl.querySelector(".pRowQty").value;
            const costStr = rowEl.querySelector(".pRowCost").value;
            const measurements = readMeasurements(rowEl, "pRow");
            if (!name && !qtyStr && !costStr && measurements.chestInches == null && measurements.lengthInches == null) return; // skip fully-empty rows
            const qty = Number(qtyStr);
            const priceVal = parseFloat(
              rowEl.querySelector(".pRowPrice").value,
            );
            const typeInput = rowEl.querySelector(
              ".pending-row-type input:checked",
            );
            if (!name) {
              rowError = "กรุณาระบุชื่อสินค้าในแถวที่ " + (i + 1);
              return;
            }
            if (!Number.isSafeInteger(qty) || qty < 1) {
              rowError = "ระบุจำนวนให้ถูกต้องในแถวที่ " + (i + 1);
              return;
            }
            let cost = null;
            if (pendingCostMode !== "lump") {
              cost = parseFloat(costStr);
              if (isNaN(cost) || cost < 0) {
                rowError = "กรุณาระบุราคาต้นทุนในแถวที่ " + (i + 1);
                return;
              }
            }
            rows.push({
              name,
              ...(productId ? { productId } : {}),
              color: rowEl.querySelector(".pRowColor").value.trim(),
              size: rowEl.querySelector(".pRowSize").value.trim(),
              ...readMeasurements(rowEl, "pRow"),
              type: typeInput ? typeInput.value : "new",
              qty,
              cost,
              price: isNaN(priceVal) ? 0 : priceVal,
            });
          });
          if (rowError) {
            showAlert(rowError);
            return;
          }
          if (rows.length === 0) {
            showAlert("กรุณาเพิ่มรายการสินค้าที่สั่งซื้ออย่างน้อย 1 รายการ");
            return;
          }
          if (pendingCostMode === "lump") {
            const lumpTotal = parseFloat(fd.get("pendingLumpCost"));
            if (!lumpTotal || lumpTotal <= 0) {
              showAlert("กรุณาระบุยอดที่จ่ายทั้งล็อต");
              return;
            }
            const totalQty = rows.reduce((s, r) => s + r.qty, 0);
            const unitCost = lumpTotal / totalQty;
            rows.forEach((r) => (r.cost = unitCost));
          }
          await addPendingOrderBatch(rows, fd.get("pendingNote") || "");
        } else {
          const globalCostMode =
            document.querySelector(
              '#global-cost-mode-toggle input[name="globalCostMode"]:checked',
            )?.value || "perproduct";
          const blockEls = document.querySelectorAll(
            "#product-blocks .product-block",
          );
          const blockData = [];
          let err = null;

          blockEls.forEach((block, bi) => {
            const rowEls = block.querySelectorAll(".pb-size-row");
            const blockRows = [];
            rowEls.forEach((rowEl) => {
              const color = rowEl.querySelector(".pbRowColor").value.trim();
              const size = rowEl.querySelector(".pbRowSize").value.trim();
              const qty =
                Number(rowEl.querySelector(".pbRowQty").value);
              const measurements = readMeasurements(rowEl, "pbRow");
              if (!color && !size && !qty && measurements.chestInches == null && measurements.lengthInches == null) return; // แถวว่างทั้งหมด ข้ามไป
              if (!Number.isSafeInteger(qty) || qty < 1) { err = `ระบุจำนวนเต็มมากกว่า 0 ในกลุ่มที่ ${bi + 1}`; return; }
              blockRows.push({ color, size, qty, ...measurements });
            });
            if (blockRows.length === 0) return; // สินค้าตัวนี้ยังไม่ได้กรอกอะไร ข้ามไปเลย

            const name = block.querySelector(".pb-name").value.trim();
            if (!name) {
              err = `กรุณาระบุชื่อสินค้าในกลุ่มที่ ${bi + 1}`;
              return;
            }
            const type =
              block.querySelector(".pb-type-toggle input:checked")?.value ||
              "new";
            const priceVal = parseFloat(block.querySelector(".pb-price").value);
            if (isNaN(priceVal) || priceVal < 0) {
              err = `กรุณาระบุราคาที่ตั้งใจขายของสินค้า "${name}"`;
              return;
            }

            let unitCost = null;
            if (globalCostMode === "perproduct") {
              const costMode =
                block.querySelector(".pb-cost-mode-toggle input:checked")
                  ?.value || "perunit";
              if (costMode === "lump") {
                const lumpVal = parseFloat(
                  block.querySelector(".pb-cost-lump").value,
                );
                if (isNaN(lumpVal) || lumpVal < 0) {
                  err = `กรุณาระบุยอดต้นทุนทั้งล็อตของสินค้า "${name}"`;
                  return;
                }
                const totalQty = blockRows.reduce((s, r) => s + r.qty, 0);
                unitCost = totalQty > 0 ? lumpVal / totalQty : 0;
              } else {
                unitCost = parseFloat(
                  block.querySelector(".pb-cost-perunit").value,
                );
                if (isNaN(unitCost) || unitCost < 0) {
                  err = `กรุณาระบุต้นทุนต่อชิ้นของสินค้า "${name}"`;
                  return;
                }
              }
            }

            blockData.push({
              name,
              type,
              price: priceVal,
              imageFile: block.querySelector(".pb-image").files[0] || null,
              rows: blockRows,
              unitCost,
            });
          });

          if (err) {
            showAlert(err);
            return;
          }
          if (blockData.length === 0) {
            showAlert(
              "กรุณาเพิ่มสินค้าอย่างน้อย 1 รายการ พร้อมสี/ไซส์และจำนวน",
            );
            return;
          }

          if (globalCostMode === "lumpall") {
            const lumpAll = parseFloat(
              document.getElementById("lumpAllCost").value,
            );
            if (isNaN(lumpAll) || lumpAll < 0) {
              showAlert("กรุณาระบุยอดที่จ่ายทั้งหมด");
              return;
            }
            const grandTotalQty = blockData.reduce(
              (s, b) => s + b.rows.reduce((s2, r) => s2 + r.qty, 0),
              0,
            );
            const unitCostAll = grandTotalQty > 0 ? lumpAll / grandTotalQty : 0;
            blockData.forEach((b) => {
              b.unitCost = unitCostAll;
            });
          }

          for (const b of blockData) {
            if (b.imageFile && b.imageFile.size > 0) {
              try {
                b.image = await resizeImageFile(b.imageFile);
              } catch (err2) {
                console.error("image resize failed", err2);
                b.image = null;
              }
            } else {
              b.image = null;
            }
          }

          const rows = [];
          blockData.forEach((b) => {
            b.rows.forEach((r) => {
              rows.push({
                name: b.name,
                color: r.color,
                size: r.size,
                ...measurementsOf(r),
                qty: r.qty,
                type: b.type,
                price: b.price,
                cost: b.unitCost,
                image: b.image,
              });
            });
          });

          const base = {
            logExpense: fd.get("logExpense") === "on",
            shippingIn: parseFloat(fd.get("shippingIn")) || 0,
          };
          await addProductBatch(base, rows);
        }
      } catch (err) {
        console.error("add-product-form submit failed", err);
        const message =
          err && err.message ? err.message : "ไม่สามารถบันทึกข้อมูลได้";
        if (!err.storageReported) showAlert("บันทึกสินค้าไม่สำเร็จ: " + message);
      } finally {
        submitBtn.dataset.saving = "false";
        submitBtn.disabled = false;
        submitBtn.textContent = originalSubmitText;
      }
    };
  document.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = () => deleteVariant(btn.dataset.del);
  });
  document.querySelectorAll("[data-edit]").forEach((btn) => {
    btn.onclick = () => openEdit(btn.dataset.edit);
  });
  const mergeButton = document.getElementById("merge-data-btn");
  if (mergeButton)
    mergeButton.onclick = async () => {
      const preview = duplicateMergePreview();
      if (preview.duplicateProducts === 0 && preview.duplicateVariants === 0) {
        showAlert("ไม่พบข้อมูลชื่อสินค้า สี และไซส์ที่ซ้ำกัน");
        return;
      }
      const message = `พบสินค้าชื่อซ้ำ ${preview.duplicateProducts} กลุ่ม และตัวเลือกสี/ไซส์ซ้ำ ${preview.duplicateVariants} รายการ\n\nต้องการรวมจำนวนและคำนวณต้นทุนเฉลี่ยถ่วงน้ำหนักใหม่หรือไม่?`;
      if (!(await showConfirm(message))) return;
      try {
        const merged = await mergeDuplicateData();
        showAlert(
          merged == null
            ? "ไม่พบข้อมูลที่ต้องรวม"
            : `รวมข้อมูลสำเร็จ${merged ? ` (${merged} รายการตัวเลือก)` : ""}`,
        );
      } catch (err) {
        console.error("merge duplicate data failed", err);
        showAlert("รวมข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง");
      }
    };
  const pendingSelectAllBtn = document.getElementById("pending-select-all");
  if (pendingSelectAllBtn) {
    pendingSelectAllBtn.onclick = () => {
      const boxes = document.querySelectorAll(".pending-select");
      const allChecked = [...boxes].every((b) => b.checked);
      boxes.forEach((b) => (b.checked = !allChecked));
      pendingSelectAllBtn.textContent = allChecked
        ? "เลือกทั้งหมด"
        : "ยกเลิกที่เลือกทั้งหมด";
    };
  }
  const pendingReceiveBtn = document.getElementById("pending-receive-selected");
  if (pendingReceiveBtn) {
    pendingReceiveBtn.onclick = async () => {
      const ids = [...document.querySelectorAll(".pending-select:checked")].map(
        (cb) => cb.dataset.pendingId,
      );
      if (ids.length === 0) {
        showAlert("กรุณาติ๊กเลือกรายการที่ต้องการยืนยันว่าได้รับของแล้ว");
        return;
      }
      const shipAmt = document.getElementById("pending-bulk-ship").value;
      await receivePendingOrdersBulk(ids, shipAmt, Object.fromEntries([...document.querySelectorAll(".pending-receive-qty")].map(input => [input.dataset.pendingId, input.value])));
    };
  }
  document.querySelectorAll("[data-cancel-pending]").forEach((btn) => {
    btn.onclick = () => deletePendingOrder(btn.dataset.cancelPending);
  });

  // --- bulk attach shipping ---
  document.querySelectorAll(".attach-size-select").forEach((sel) => {
    sel.onchange = () => {
      const row = sel.closest("[data-attach-row]");
      const qtyInput = row.querySelector(".attach-qty");
      const found = findVariant(sel.value);
      qtyInput.dataset.variant = sel.value;
      const maxQty = found ? found.variant.qty : 0;
      qtyInput.max = maxQty;
      if (Number(qtyInput.value) > maxQty) qtyInput.value = 0;
    };
  });
  const attachSearch = document.getElementById("attach-ship-search");
  if (attachSearch) {
    attachSearch.oninput = () => {
      const q = attachSearch.value.trim().toLowerCase();
      document.querySelectorAll("[data-attach-row]").forEach((row) => {
        row.hidden = Boolean(q && !row.dataset.attachLabel.includes(q));
      });
    };
  }
  const attachSubmit = document.getElementById("attach-ship-submit");
  if (attachSubmit) {
    attachSubmit.onclick = () => {
      const items = [];
      document.querySelectorAll(".attach-qty").forEach((inp) => {
        const qty = Number(inp.value || 0);
        if (!Number.isSafeInteger(qty) || qty < 0) { items.push({ qty: NaN }); return; }
        if (qty > 0) {
          const found = findVariant(inp.dataset.variant);
          if (found)
            items.push({
              variantId: inp.dataset.variant,
              qty,
              label: variantLabel(found.product, found.variant),
            });
        }
      });
      if (items.length === 0) {
        showAlert("กรุณาเลือกสินค้าที่จะแนบค่าส่งอย่างน้อย 1 รายการ");
        return;
      }
      const amount = parseFloat(
        document.getElementById("attach-ship-amount").value,
      );
      if (!amount || amount <= 0) {
        showAlert("กรุณาระบุยอดค่าส่งรวมให้ถูกต้อง");
        return;
      }
      const date = document.getElementById("attach-ship-date").value;
      attachShippingBulk(items, amount, date);
    };
  }
}

// ---------- Sell tab ----------
function renderSellTab() {
  const groups = saleProductGroups();
  const cards = groups
    .map((group, index) => {
      const colors = [
        ...new Set(group.variants.map(({ variant }) => variant.color || "-")),
      ];
      const firstColor = colors[0];
      const first = group.variants.find(
        ({ variant }) => (variant.color || "-") === firstColor,
      ).variant;
      const colorOptions = colors
        .map(
          (color) =>
            `<option value="${escapeHtml(color)}">${escapeHtml(color)}</option>`,
        )
        .join("");
      const sizeOptions = group.variants
        .map(
          ({ variant }) =>
            `<option value="${variant.id}" data-color="${escapeHtml(variant.color || "-")}">ไซส์ ${escapeHtml(variant.size || "-")} · ${variant.type === "used" ? "มือ2" : "มือ1"} ${measurementLabel(variant) ? ` · ${escapeHtml(measurementLabel(variant))}` : ""} · เหลือ ${variant.qty}</option>`,
        )
        .join("");
      return `
      <div class="sell-card" data-sale-card="${index}">
        <div class="sell-card-top"><span class="tag ${first.type}">มือ${first.type === "used" ? "2" : "1"}</span><span class="sell-stock">คงเหลือ ${first.qty}</span></div>
        <div style="display:flex; gap:10px; align-items:flex-start;">
          <div class="thumb" style="width:40px;height:40px;flex-shrink:0;">${group.image ? `<img src="${escapeHtml(group.image)}" alt="">` : '<span class="thumb-ph">👕</span>'}</div>
          <div style="flex:1; min-width:0;"><div class="sell-name">${escapeHtml(group.name)}</div><div class="sell-price">${fmtMoney(first.price)} <span class="sell-cost-note">ต้นทุน ${fmtMoney(first.cost)}</span></div></div>
        </div>
        <div class="sell-picker"><div class="field"><label>สี</label><select class="sell-color-select">${colorOptions}</select></div><div class="field"><label>ไซส์</label><select class="sell-size-select">${sizeOptions}</select></div></div>
        <div class="sell-form">
          <div class="field"><label>จำนวน</label><input class="sell-qty" type="number" min="1" max="${first.qty}" value="1"></div>
          <div class="field"><label>ราคาขายจริง/ชิ้น</label><input class="sell-price-input" type="number" min="0" step="0.01" value="${first.price}"></div>
          <div class="field"><label>ค่าส่ง (รวม)</label><input class="sell-shipping" type="number" min="0" step="0.01" value="0"></div>
          <div class="field"><label>ค่ากลาง (รวม)</label><input class="sell-commission" type="number" min="0" step="0.01" value="0"></div>
        </div>
        <div class="field"><label>ยอดขายมาจากแคมเปญ (ถ้ามี)</label><select class="sell-ad-campaign"><option value="">ไม่ระบุแคมเปญ</option></select></div>
        <p class="hint sell-ad-preview"></p>
        <div class="sale-total" aria-live="polite"><span>ยอดขายรวม / กำไรประมาณ</span><b class="sale-total-value"></b></div>
        <button class="btn btn-gold btn-sm sell-submit" style="width:100%; margin-top:10px;" data-sell="${first.id}">${icon("bag")}บันทึกการขาย</button>
        <div class="checkline" style="margin-top:10px;"><input type="checkbox" class="sell-installment"><label>ลูกค้าผ่อนชำระ (ไม่ได้เงินก้อนเดียว)</label></div>
        <div class="field sell-installment-fields" style="display:none; margin-top:6px;"><label>ผ่อนชำระให้ครบภายใน (วัน)</label><input class="sell-due-days" type="number" min="1" value="30"><label style="margin-top:6px;">มัดจำที่ได้รับตอนนี้ (ถ้ามี)</label><input class="sell-deposit" type="number" min="0" step="0.01" value="0"></div><div class="field"><label>ลูกค้า / ผู้รับ / เลขคำสั่งซื้อ (ถ้ามี)</label><input class="sell-customer" type="text" maxlength="2000" placeholder="เช่น ชื่อลูกค้า, เบอร์โทร"><p class="hint">บันทึกการขายแล้วจะอยู่ในสถานะรอส่ง</p></div>
      </div>`;
    })
    .join("");

  const outOfStock = allVariants().filter(({ variant }) => variant.qty <= 0);
  const outList = outOfStock.length
    ? `
    <p class="hint" style="margin-top:18px;">สินค้าหมดสต็อก: ${outOfStock.map(({ product, variant }) => escapeHtml(variantLabel(product, variant))).join(", ")}</p>
  `
    : "";

  return `
    <div class="panel">
      <div class="section-heading"><h2>เลือกสินค้าที่ต้องการขาย</h2><button class="btn btn-ghost" data-go="shipments">รอส่ง (${pendingDeliveries(transactions,shipments).length})</button></div>
      <p class="hint">ใส่ราคาขายจริง ค่าส่ง และค่ากลาง (ถ้ามี) แล้วบันทึกการขาย ระบบจะตัดสต็อก บันทึกยอดขาย และนำสินค้าเข้ารอส่ง กดส่งสินค้าแล้วได้จากเมนูรอส่ง</p>
      <div class="inventory-toolbar"><div class="field search-field">${icon("search")}<input type="search" id="sell-search" aria-label="ค้นหาสินค้าพร้อมขาย" placeholder="ค้นหาสินค้าที่ต้องการขาย" value="${escapeHtml(sellSearch)}"></div><span id="sell-count" class="inventory-count"></span></div>
      <div id="sell-no-results" class="empty" hidden>ไม่พบสินค้าที่ตรงกับคำค้นหา</div>
      ${
        groups.length === 0
          ? `
        <div class="empty">
          <div class="big">ไม่มีสินค้าพร้อมขาย</div>
          เพิ่มสินค้าในแท็บ "สต็อกสินค้า" ก่อน
        </div>`
          : `<div class="sell-grid">${cards}</div>`
      }
      ${outList}
    </div>
  `;
}

function wireSellTab() {
  const search = document.getElementById("sell-search");
  function filterSales() {
    if (!search) return;
    sellSearch = search.value;
    let count = 0;
    document.querySelectorAll("[data-sale-card]").forEach((card) => {
      card.hidden = !normalizedText(
        card.querySelector(".sell-name").textContent +
          " " +
          card.querySelector(".sell-color-select").textContent,
      ).includes(normalizedText(sellSearch));
      if (!card.hidden) count++;
    });
    document.getElementById("sell-count").textContent =
      `${count} สินค้าพร้อมขาย`;
    document.getElementById("sell-no-results").hidden =
      count > 0 || !sellSearch;
  }
  if (search) {
    search.oninput = filterSales;
    filterSales();
  }
  function updateSaleTotal(card) {
    const found = findVariant(card.querySelector(".sell-size-select").value);
    if (!found) return;
    const qty = Number(card.querySelector(".sell-qty").value) || 0,
      price = Number(card.querySelector(".sell-price-input").value) || 0;
    const total = qty * price,
      profit =
        total -
        qty * found.variant.cost -
        (Number(card.querySelector(".sell-shipping").value) || 0) -
        (Number(card.querySelector(".sell-commission").value) || 0);
    card.querySelector(".sale-total-value").textContent =
      `${fmtMoney(total)} / ${fmtMoney(profit)}`;
    const campaign = adCampaigns.find(c => c.id === card.querySelector(".sell-ad-campaign").value);
    card.querySelector(".sell-ad-preview").textContent = campaign ? `งบแอดตามเป้า ${fmtMoney(campaign.budget / campaign.targetQty)}/ชิ้น · กำไรคาดการณ์หลังเผื่องบแอด ${fmtMoney(profit - qty * campaign.budget / campaign.targetQty)} · กำไรจริงและเงินแนะนำเก็บดูในเมนูยิงแอดหลังบันทึกค่าแอด` : "กำไรประมาณด้านล่างยังไม่หักค่าแอด เลือกแคมเปญเพื่อผูกยอดขาย";
  }
  function syncSaleCard(card) {
    const color = card.querySelector(".sell-color-select").value;
    const size = card.querySelector(".sell-size-select");
    [...size.options].forEach((option) => {
      option.hidden = option.dataset.color !== color;
      option.disabled = option.dataset.color !== color;
    });
    if (size.selectedOptions[0]?.disabled)
      size.value =
        [...size.options].find((option) => !option.disabled)?.value || "";
    const found = findVariant(size.value);
    if (!found) return;
    const { variant } = found;
    card.querySelector(".sell-stock").textContent = "คงเหลือ " + variant.qty;
    card.querySelector(".sell-card-top .tag").className = "tag " + variant.type;
    card.querySelector(".sell-card-top .tag").textContent =
      variant.type === "used" ? "มือ2" : "มือ1";
    card.querySelector(".sell-price").innerHTML =
      `${fmtMoney(variant.price)} <span class="sell-cost-note">ต้นทุน ${fmtMoney(variant.cost)}</span>`;
    const adSelect = card.querySelector(".sell-ad-campaign"), previousCampaign = adSelect.value;
    adSelect.innerHTML = '<option value="">ไม่ระบุแคมเปญ</option>' + adCampaigns.filter(c => campaignHasProduct(c, found.product.id) && c.status !== "cancelled").map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} · ${c.startDate}–${campaignUntilBudget(c) ? 'จนงบหมด' : c.endDate}</option>`).join("");
    if ([...adSelect.options].some(o => o.value === previousCampaign)) adSelect.value = previousCampaign;
    const qty = card.querySelector(".sell-qty");
    qty.max = variant.qty;
    if (Number(qty.value) > variant.qty) qty.value = 1;
    card.querySelector(".sell-price-input").value = variant.price;
    card.querySelector(".sell-submit").dataset.sell = variant.id;
    const thumb = card.querySelector(".thumb"),
      src = productColorImage(found.product, variant.color);
    thumb.innerHTML = src
      ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(found.product.name)}">`
      : `<span class="thumb-ph">${icon("shirt")}</span>`;
    updateSaleTotal(card);
  }
  document.querySelectorAll("[data-sale-card]").forEach((card) => {
    card.querySelector(".sell-ad-campaign").onchange = () => updateSaleTotal(card);
    card.querySelector(".sell-color-select").onchange = () =>
      syncSaleCard(card);
    card.querySelector(".sell-size-select").onchange = () => syncSaleCard(card);
    card.querySelector(".sell-installment").onchange = (event) => {
      card.querySelector(".sell-installment-fields").style.display = event
        .target.checked
        ? "block"
        : "none";
    };
    card
      .querySelectorAll(".sell-form input")
      .forEach((input) =>
        input.addEventListener("input", () => updateSaleTotal(card)),
      );
    syncSaleCard(card);
  });
  document.querySelectorAll("[data-sell]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.sell;
      const card = btn.closest("[data-sale-card]");
      sellVariant(id, {
        qty: card.querySelector(".sell-qty").value,
        sellPrice: card.querySelector(".sell-price-input").value,
        shipping: card.querySelector(".sell-shipping").value,
        commission: card.querySelector(".sell-commission").value,
        installment: card.querySelector(".sell-installment").checked,
        dueDays: card.querySelector(".sell-due-days").value,
        deposit: card.querySelector(".sell-deposit").value,
        customerNote: card.querySelector(".sell-customer").value,
        adCampaignId: card.querySelector(".sell-ad-campaign").value,
      });
    };
  });
}

// ---------- Installments tab ----------
function renderInstallmentsTab() {
  const all = transactions.filter((t) => t.type === "installment");
  const today = todayStr();
  const outstanding = openInstallments().sort((a, b) =>
    String(a.dueDate || "").localeCompare(String(b.dueDate || "")),
  );
  const settled = all.filter((t) => t.amount - (t.paidAmount || 0) <= 0.001);

  const rowHtml = (t) => {
    const remaining = Math.max(0, t.amount - (t.paidAmount || 0));
    const overdue = remaining > 0.001 && t.dueDate < today;
    return `
      <tr class="${overdue ? "overdue-row" : ""}">
        <td class="num" style="font-family:'IBM Plex Mono',monospace;">${t.date}</td>
        <td>${escapeHtml(t.desc || "")}${t.deliveryStatus ? `<span class="tag preorder">${deliveryLabels[t.deliveryStatus] || ""}</span>` : ""}</td>
        <td class="num">${fmtMoney(t.amount)}</td>
        <td class="num" style="color:var(--green);">${fmtMoney(t.paidAmount || 0)}</td>
        <td class="num" style="color:${remaining > 0.001 ? "var(--red)" : "var(--green)"}; font-weight:700;">${fmtMoney(remaining)}</td>
        <td>${t.dueDate}${overdue ? ' <span style="color:var(--red); font-weight:700;">(เกินกำหนด)</span>' : ""}</td>
        <td>${remaining > 0.001 ? `<button class="btn btn-gold btn-sm" data-pay="${t.id}">รับชำระเพิ่ม</button>` : '<span class="tag income">ชำระครบแล้ว</span>'}</td>
      </tr>
    `;
  };

  const balance = outstanding.reduce(
    (sum, t) => sum + t.amount - (t.paidAmount || 0),
    0,
  );
  const overdueCount = outstanding.filter(
    (t) => t.dueDate && t.dueDate < today,
  ).length;
  return `
    <section class="stats installment-stats" aria-label="สรุปการผ่อนชำระ">${metric("ยอดค้างชำระ", fmtMoney(balance), `${outstanding.length} รายการที่ยังรับไม่ครบ`, "wallet")}${metric("เกินกำหนด", overdueCount.toLocaleString("th-TH"), "รายการที่ควรติดตามก่อน", "clock", "expense-stat")}${metric("ชำระครบแล้ว", settled.length.toLocaleString("th-TH"), "รายการผ่อนที่ปิดยอดแล้ว", "check", "income-stat")}</section>
    <div class="panel">
      <h2>ลูกหนี้ผ่อนชำระ</h2>
      <p class="hint">ยอดขายแบบผ่อนชำระจะยังไม่นับเป็น "รายรับ" จนกว่าจะได้รับเงินจริง (นับกำไร/จำนวนขายทันทีเพื่อสถิติสินค้า) ส่วนนี้ใช้ติดตามว่าใครค้างชำระอยู่เท่าไหร่และครบกำหนดเมื่อไหร่</p>
      ${
        outstanding.length === 0
          ? `<div class="empty"><div class="big">ไม่มีลูกหนี้ค้างชำระ</div></div>`
          : `
      <table>
        <thead><tr><th>วันที่ขาย</th><th>รายการ</th><th class="num">ยอดขาย</th><th class="num">ชำระแล้ว</th><th class="num">ค้างชำระ</th><th>ครบกำหนด</th><th></th></tr></thead>
        <tbody>${outstanding.map(rowHtml).join("")}</tbody>
      </table>`
      }
    </div>
    ${
      settled.length === 0
        ? ""
        : `
    <div class="panel">
      <h2>ผ่อนชำระครบแล้ว</h2>
      <table>
        <thead><tr><th>วันที่ขาย</th><th>รายการ</th><th class="num">ยอดขาย</th><th class="num">ชำระแล้ว</th><th class="num">ค้างชำระ</th><th>ครบกำหนด</th><th></th></tr></thead>
        <tbody>${settled.map(rowHtml).join("")}</tbody>
      </table>
    </div>`
    }
  `;
}

function wireInstallmentsTab() {
  document.querySelectorAll("[data-pay]").forEach((btn) => {
    btn.onclick = () => openPaymentModal(btn.dataset.pay);
  });
}

// ---------- Transactions tab ----------
function renderTxTab() {
  const rows = [...transactions]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(
      (t) => `
    <tr>
      <td class="num" style="font-family:'IBM Plex Mono',monospace;">${t.date}</td>
      <td><span class="tag ${t.type}">${t.type === "income" ? "รายรับ" : t.type === "installment" ? "ผ่อนชำระ" : t.type === "preorder" ? "ยอดขาย pre-order" : "รายจ่าย"}</span></td>
      <td>${escapeHtml(t.category || "")}</td>
      <td>${escapeHtml(t.desc || "")}${t.deliveryStatus ? `<span class="tag preorder">${deliveryLabels[t.deliveryStatus] || ""}</span>` : ""}</td>
      <td class="num" style="color:${t.type === "income" ? "var(--green)" : ["installment", "preorder"].includes(t.type) ? "var(--navy-3)" : "var(--red)"}">${t.type === "income" ? "+" : ["installment", "preorder"].includes(t.type) ? "" : "−"}${fmtMoney(t.amount)}</td>
      <td>${isManualTransaction(t) ? `<button class="btn btn-ghost btn-sm" data-txedit="${escapeHtml(t.id)}">แก้ไข</button>` : ""}<button class="${t.preorderId ? "btn btn-ghost btn-sm" : "btn-danger"}" data-txdel="${escapeHtml(t.id)}" ${t.preorderId ? 'title="จัดการจากหน้า Pre-order ลูกค้า"' : ""}>${t.preorderId ? "ดู pre-order" : "ลบ"}</button></td>
    </tr>
  `,
    )
    .join("");

  return `
    <div class="panel">
      <h2>${editingTransaction ? "แก้ไขรายการบัญชี" : "บันทึกรายการรายรับ-รายจ่ายเพิ่มเติม"}</h2>
      <p class="hint">สำหรับค่าใช้จ่ายอื่นๆ ที่ไม่ใช่ต้นทุนสินค้า เช่น ค่าเช่า ค่าขนส่ง หรือรายรับอื่น</p>
      <form id="add-tx-form">
        <div class="form-grid">
          <div class="field">
            <label>ประเภท</label>
            <select name="type">
              <option value="expense">รายจ่าย</option>
              <option value="income">รายรับ</option>
            </select>
          </div>
          <div class="field">
            <label>หมวดหมู่</label>
            <input type="text" name="category" placeholder="เช่น ค่าเช่าร้าน">
          </div>
          <div class="field" style="grid-column:span 2">
            <label>รายละเอียด</label>
            <input type="text" name="desc" placeholder="รายละเอียดเพิ่มเติม">
          </div>
          <div class="field">
            <label>จำนวนเงิน (บาท)</label>
            <input type="number" name="amount" min="0" step="0.01" required>
          </div>
          <div class="field">
            <label>วันที่</label>
            <input type="date" name="date" value="${todayStr()}">
          </div>
        </div>
        <div style="margin-top:12px;"><button type="submit" class="btn btn-primary">${editingTransaction ? "บันทึกการแก้ไข" : "บันทึกรายการ"}</button>${editingTransaction ? '<button type="button" class="btn btn-ghost" id="tx-cancel-edit">ยกเลิกการแก้ไข</button>' : ""}</div>
      </form>
    </div>

    <div class="panel">
      <h2>ประวัติรายการทั้งหมด</h2><button class="btn btn-ghost btn-sm" data-export="filtered-transactions">ส่งออกรายการที่กรอง CSV</button>
      <div class="transaction-filters"><div class="field search-field">${icon("search")}<input id="tx-search" type="search" aria-label="ค้นหารายการบัญชี" placeholder="ค้นหารายการ หมวดหมู่ หรือรายละเอียด" value="${escapeHtml(txSearch)}"></div><div class="field"><select id="tx-type-filter" aria-label="กรองประเภทรายการ">${[
        ["all", "ทุกประเภท"],
        ["income", "รายรับ"],
        ["expense", "รายจ่าย"],
        ["installment", "ผ่อนชำระ"],
        ["preorder", "ยอดขาย pre-order (ไม่ใช่เงินรับเพิ่ม)"],
      ]
        .map(
          ([v, l]) =>
            `<option value="${v}" ${txTypeFilter === v ? "selected" : ""}>${l}</option>`,
        )
        .join(
          "",
        )}</select></div><div class="field"><input id="tx-month-filter" type="month" aria-label="กรองตามเดือน" value="${txMonthFilter}"></div><button class="btn btn-ghost btn-sm" id="tx-clear-filters">ล้างตัวกรอง</button></div><p class="hint" id="tx-result-count" aria-live="polite"></p>
      ${
        transactions.length === 0
          ? `
        <div class="empty">
          <div class="big">ยังไม่มีรายการบัญชี</div>
          รายการจะเพิ่มอัตโนมัติเมื่อขายสินค้า หรือเพิ่มด้วยตนเองจากฟอร์มด้านบน
        </div>`
          : `
        <table>
          <thead><tr><th>วันที่</th><th>ประเภท</th><th>หมวดหมู่</th><th>รายละเอียด</th><th class="num">จำนวนเงิน</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      }
    </div>
  `;
}

function wireTxTab() {
  const search = document.getElementById("tx-search"),
    type = document.getElementById("tx-type-filter"),
    month = document.getElementById("tx-month-filter");
  function filterTransactions() {
    if (!search) return;
    txSearch = search.value;
    txTypeFilter = type.value;
    txMonthFilter = month.value;
    const rows = [...document.querySelectorAll("[data-txdel]")].map((b) =>
      b.closest("tr"),
    );
    let count = 0;
    rows.forEach((row) => {
      const tx = transactions.find(
        (t) => t.id === row.querySelector("[data-txdel]").dataset.txdel,
      );
      const match =
        (!txSearch ||
          normalizedText([tx.desc, tx.category, tx.date].join(" ")).includes(
            normalizedText(txSearch),
          )) &&
        (txTypeFilter === "all" || tx.type === txTypeFilter) &&
        (!txMonthFilter || tx.date.startsWith(txMonthFilter));
      row.hidden = !match;
      if (match) count++;
    });
    document.getElementById("tx-result-count").textContent = transactions.length
      ? `แสดง ${count} จาก ${transactions.length} รายการ`
      : "";
  }
  if (search) {
    search.oninput = filterTransactions;
    type.onchange = filterTransactions;
    month.oninput = filterTransactions;
    document.getElementById("tx-clear-filters").onclick = () => {
      search.value = "";
      type.value = "all";
      month.value = "";
      filterTransactions();
    };
    filterTransactions();
  }
  const f = document.getElementById("add-tx-form");
  if (f && editingTransaction) {
    ["type", "category", "desc", "amount", "date"].forEach(key => { f.elements.namedItem(key).value = editingTransaction[key] ?? ""; });
    document.getElementById("tx-cancel-edit").onclick = () => { editingTransaction = null; render(); };
  }
  document.querySelectorAll("[data-txedit]").forEach(button => {
    button.onclick = () => {
      const tx = transactions.find(item => item.id === button.dataset.txedit);
      if (!tx || !isManualTransaction(tx)) return;
      editingTransaction = copyData(tx); render();
      document.querySelector('#add-tx-form [name="amount"]').focus();
    };
  });
  if (f)
    f.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const amount = parseFloat(fd.get("amount"));
      if (!amount || amount <= 0) {
        showAlert("ระบุจำนวนเงินให้ถูกต้อง");
        return;
      }
      addManualTx({
        type: fd.get("type"),
        category: fd.get("category").trim(),
        desc: fd.get("desc").trim(),
        amount,
        date: fd.get("date") || todayStr(),
      });
    };
  document.querySelectorAll("[data-txdel]").forEach((btn) => {
    btn.onclick = () => {
      const tx = transactions.find(item => item.id === btn.dataset.txdel);
      if (tx?.preorderId) { preorderSearch = tx.preorderId; preorderFilter = "all"; navigateTo("preorder"); }
      else deleteTx(btn.dataset.txdel);
    };
  });
}

// ---------- Report tab ----------
function renderReportTab() {
  const keys = Array.from(new Set(transactions.map((t) => monthKey(t.date))))
    .sort()
    .reverse();
  const sales = transactions.filter(
    (t) => t.category === "ขายสินค้า" && t.profit != null,
  );

  if (keys.length === 0) {
    return `<div class="panel"><h2>รายรับ–รายจ่ายรายเดือน</h2>
      <div class="empty"><div class="big">ยังไม่มีข้อมูลสำหรับสรุปรายเดือน</div>เมื่อมีการขายสินค้าหรือบันทึกรายรับ-รายจ่าย รายงานจะแสดงที่นี่</div>
    </div>`;
  }
  const maxTotal = Math.max(
    ...keys.map((k) => {
      const s = monthSummary(k);
      return s.income + s.expense;
    }),
    1,
  );
  const rows = keys
    .map((k) => {
      const s = monthSummary(k);
      const inPct = ((s.income / maxTotal) * 100).toFixed(1);
      const exPct = ((s.expense / maxTotal) * 100).toFixed(1);
      return `
      <div class="month-row">
        <div class="month-label">${monthLabel(k)}</div>
        <div>
          <div class="bar-wrap"><div class="bar-in" style="width:${inPct}%"></div><div class="bar-ex" style="width:${exPct}%"></div></div>
          <div class="month-sub">รับ ${fmtMoney(s.income)} · จ่าย ${fmtMoney(s.expense)}</div>
        </div>
        <div class="month-profit ${s.profit < 0 ? "neg" : "pos"}">${fmtMoney(s.profit)}</div>
      </div>
    `;
    })
    .join("");

  const saleRows = sales
    .map(
      (t) => `
    <tr>
      <td class="num" style="font-family:'IBM Plex Mono',monospace;">${t.date}</td>
      <td>${escapeHtml(t.desc || "")}</td>
      <td class="num">${t.qty || 0}</td>
      <td class="num">${fmtMoney(t.unitPrice)}</td>
      <td class="num">${fmtMoney(t.unitCost)}</td>
      <td class="num">${fmtMoney(t.shipping || 0)}</td>
      <td class="num">${fmtMoney(t.commission || 0)}</td>
      <td class="num" style="color:${t.profit < 0 ? "var(--red)" : "var(--green)"}; font-weight:700;">${fmtMoney(t.profit)}</td>
    </tr>
  `,
    )
    .join("");

  const saleSection =
    sales.length === 0
      ? ""
      : `
    <div class="panel">
      <h2>กำไรตามรายการขาย</h2>
      <p class="hint">กำไรจากการขาย = (ราคาขายจริง − ต้นทุน) × จำนวน − ค่าส่ง − ค่ากลาง ยังไม่หักค่าใช้จ่ายทั่วไป</p>
      <table>
        <thead><tr><th>วันที่</th><th>รายการ</th><th class="num">จำนวน</th><th class="num">ราคาขาย/ชิ้น</th><th class="num">ต้นทุน/ชิ้น</th><th class="num">ค่าส่ง</th><th class="num">ค่ากลาง</th><th class="num">กำไรจากการขาย</th></tr></thead>
        <tbody>${saleRows}</tbody>
      </table>
    </div>
  `;

  const top = topSellers(5, "qty");
  const topRows = top
    .map(
      (t, i) => `
    <tr>
      <td class="num" style="font-family:'IBM Plex Mono',monospace; font-weight:700; color:var(--navy);">#${i + 1}</td>
      <td>${escapeHtml(t.name)}</td>
      <td class="num">${t.qty} ชิ้น</td>
      <td class="num" style="color:${t.profit < 0 ? "var(--red)" : "var(--green)"}; font-weight:700;">${fmtMoney(t.profit)}</td>
    </tr>
  `,
    )
    .join("");
  const topSection =
    top.length === 0
      ? ""
      : `
    <div class="panel">
      <h2>สินค้าขายดี (Top 5)</h2>
      <table>
        <thead><tr><th>อันดับ</th><th>สินค้า</th><th class="num">ขายไปแล้ว</th><th class="num">กำไรรวม</th></tr></thead>
        <tbody>${topRows}</tbody>
      </table>
    </div>
  `;

  const chartSection = `
    <div class="panel">
      <h2>กราฟแนวโน้ม 6 เดือนล่าสุด</h2>
      <div class="chart-wrap"><canvas id="trend-chart"></canvas></div>
    </div>
    <div class="panel">
      <h2>กราฟสินค้าขายดี</h2>
      <div class="chart-wrap"><canvas id="sellers-chart"></canvas></div>
    </div>
  `;

  return `<div class="panel"><h2>รายรับ–รายจ่ายรายเดือน</h2><p class="hint">เงินสดสุทธิ = เงินรับจริง − เงินจ่ายจริง ของแต่ละเดือน รวมต้นทุนสินค้าที่ซื้อเข้า</p>${rows}</div>${chartSection}${topSection}${saleSection}`;
}

let trendChartInstance = null;
let sellersChartInstance = null;
function wireReportTab() {
  wireRangeReport();
  if (typeof Chart === "undefined") return;
  const trendCanvas = document.getElementById("trend-chart");
  if (trendCanvas) {
    const months = last6MonthsKeys();
    const labels = months.map(monthLabel);
    const incomeData = months.map((k) => monthSummary(k).income);
    const expenseData = months.map((k) => monthSummary(k).expense);
    const profitData = months.map((k) => monthSummary(k).profit);
    if (trendChartInstance) trendChartInstance.destroy();
    trendChartInstance = new Chart(trendCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "รายรับ",
            data: incomeData,
            borderColor: "#1f8a5c",
            backgroundColor: "rgba(31,138,92,0.12)",
            tension: 0.3,
            fill: true,
          },
          {
            label: "รายจ่าย",
            data: expenseData,
            borderColor: "#d1435b",
            backgroundColor: "rgba(209,67,91,0.12)",
            tension: 0.3,
            fill: true,
          },
          {
            label: "กระแสเงินสดสุทธิ",
            data: profitData,
            borderColor: "#16214a",
            backgroundColor: "rgba(22,33,74,0.06)",
            tension: 0.3,
            borderWidth: 3,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { font: { family: "DM Sans", weight: 600 } },
          },
        },
        scales: {
          y: { ticks: { callback: (v) => "฿" + Number(v).toLocaleString() } },
        },
      },
    });
  }
  const sellersCanvas = document.getElementById("sellers-chart");
  if (sellersCanvas) {
    const top = topSellers(5, "qty");
    if (sellersChartInstance) sellersChartInstance.destroy();
    sellersChartInstance = new Chart(sellersCanvas, {
      type: "bar",
      data: {
        labels: top.map((t) => t.name),
        datasets: [
          {
            label: "จำนวนที่ขาย (ชิ้น)",
            data: top.map((t) => t.qty),
            backgroundColor: "#37448c",
            borderRadius: 8,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: { legend: { display: false } },
      },
    });
  }
  updateReportChartTheme();
}

// Wires clicks on .type-toggle labels directly to their radio input, instead of
// relying on native label->hidden-input click forwarding (unreliable in some
// sandboxed/mobile webviews when the input is display:none).
function wireToggleLabels(container) {
  if (!container) return;
  container.querySelectorAll("label").forEach((label) => {
    const input = label.querySelector('input[type="radio"]');
    if (!input) return;
    label.onclick = (e) => {
      if (input.disabled || e.target === input) return;
      e.preventDefault();
      if (!input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    };
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ---------- AI trend analysis ----------
function renderAiTab() {
  return `
    <div class="panel">
      <div class="panel-title-action">
        <div><h2>มองเห็นโอกาสจากข้อมูลร้าน</h2><p class="hint">สรุปยอดขาย สต็อก และยอดค้างชำระ เพื่อช่วยวางแผนงานถัดไป</p></div>
        <span class="tag">วิเคราะห์จากข้อมูล</span>
      </div>
      <p class="hint">ยังไม่ได้เชื่อมต่อบริการ AI ผลด้านล่างคำนวณด้วยกฎจากข้อมูลร้านโดยตรง ไม่ใช่คำตอบที่สร้างโดย AI และไม่มีการส่งข้อมูลไปยังบริการวิเคราะห์ภายนอก</p>
      <button class="btn btn-primary" id="ai-run-btn">${aiResult ? "อัปเดตผลวิเคราะห์" : "วิเคราะห์ข้อมูลร้าน"}</button>
      <div id="ai-result" aria-live="polite">${aiResult ? renderLocalInsights() : '<div class="empty"><div class="big">เริ่มจากข้อมูลที่คุณมี</div>ดูสิ่งที่ควรเติมสต็อก ยอดที่ควรติดตาม และสินค้าที่ควรทบทวน</div>'}</div>
    </div>
  `;
}

function renderLocalInsights() {
  const today = todayStr();
  const currentKey = today.slice(0, 7);
  const [year, month, day] = today.split("-").map(Number);
  const previousDate = new Date(year, month - 2, 1);
  const previousKey = `${previousDate.getFullYear()}-${String(previousDate.getMonth() + 1).padStart(2, "0")}`;
  const sumAmount = (list) =>
    list.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const monthToDate = transactions.filter(
    (t) => monthKey(t.date) === currentKey && t.date <= today,
  );
  const currentIncome = sumAmount(
    monthToDate.filter((t) => t.type === "income"),
  );
  const currentExpense = sumAmount(
    monthToDate.filter((t) => t.type === "expense"),
  );
  const previousIncome = sumAmount(
    transactions.filter(
      (t) =>
        t.type === "income" &&
        monthKey(t.date) === previousKey &&
        Number(t.date.slice(8, 10)) <= day,
    ),
  );
  const change =
    previousIncome > 0
      ? ((currentIncome - previousIncome) / previousIncome) * 100
      : null;
  const comparison =
    change === null
      ? "ยังไม่มีรายรับช่วงเดียวกันของเดือนก่อนให้เปรียบเทียบ"
      : `${change >= 0 ? "เพิ่มขึ้น" : "ลดลง"} ${Math.abs(change).toLocaleString("th-TH", { maximumFractionDigits: 1 })}% เทียบช่วงวันเดียวกันของเดือนก่อน`;

  const sales = transactions.filter(
    (t) => t.category === "ขายสินค้า" && t.profit != null,
  );
  const monthSales = sales.filter(
    (t) => monthKey(t.date) === currentKey && t.date <= today,
  );
  const sellers = new Map();
  monthSales.forEach((sale) => {
    const found = findVariant(sale.productId);
    const key = found ? found.product.id : sale.productId || sale.desc;
    const item = sellers.get(key) || {
      name: found ? found.product.name : sale.desc || "สินค้าที่นำออกจากสต็อก",
      qty: 0,
      revenue: 0,
      profit: 0,
    };
    item.qty += Number(sale.qty) || 0;
    item.revenue += Number(sale.amount) || 0;
    item.profit += Number(sale.profit) || 0;
    sellers.set(key, item);
  });
  const ranked = [...sellers.values()].sort((a, b) => b.qty - a.qty);
  const best = ranked[0];
  const recentQty = (variantId) =>
    monthSales
      .filter((t) => t.productId === variantId)
      .reduce((sum, t) => sum + (Number(t.qty) || 0), 0);
  const refill = allVariants()
    .filter(
      ({ variant }) =>
        variant.type === "new" && variant.qty <= LOW_STOCK_THRESHOLD,
    )
    .sort((a, b) => recentQty(b.variant.id) - recentQty(a.variant.id));

  const cutoffDate = new Date(year, month - 1, day);
  cutoffDate.setDate(cutoffDate.getDate() - 60);
  const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}-${String(cutoffDate.getDate()).padStart(2, "0")}`;
  const recentlySold = new Set(
    sales
      .filter((t) => t.date >= cutoff && t.date <= today)
      .map((t) => t.productId),
  );
  const slow = allVariants().filter(
    ({ product, variant }) =>
      variant.qty > 0 &&
      (variant.createdAt || product.createdAt || today) <= cutoff &&
      !recentlySold.has(variant.id),
  );
  const slowValue = slow.reduce(
    (sum, { variant }) => sum + variant.cost * variant.qty,
    0,
  );
  const outstanding = openInstallments();
  const outstandingValue = outstanding.reduce(
    (sum, t) => sum + Math.max(0, t.amount - (t.paidAmount || 0)),
    0,
  );
  const overdue = outstanding.filter((t) => t.dueDate && t.dueDate < today);
  const overdueValue = overdue.reduce(
    (sum, t) => sum + Math.max(0, t.amount - (t.paidAmount || 0)),
    0,
  );
  const pendingValue = pendingOrders.reduce(
    (sum, order) => sum + order.cost * order.qty,
    0,
  );
  const pendingQty = pendingOrders.reduce(
    (sum, order) => sum + Number(order.qty),
    0,
  );
  const names = (entries) =>
    entries
      .slice(0, 3)
      .map(({ product, variant }) => variantLabel(product, variant))
      .join(", ");
  const card = (label, value, detail, action) =>
    `<article class="insight-card"><p class="insight-label">${escapeHtml(label)}</p><h3>${escapeHtml(value)}</h3><p>${escapeHtml(detail)}</p>${action ? `<p class="hint">${escapeHtml(action)}</p>` : ""}</article>`;

  return `
    <p class="hint" style="margin-top:18px;">${escapeHtml(monthLabel(currentKey))} · อัปเดตตามข้อมูลล่าสุดที่ซิงก์</p>
    <div class="insights-grid">
      ${card("รายรับเดือนนี้ถึงวันนี้", fmtMoney(currentIncome), comparison, `รายจ่าย ${fmtMoney(currentExpense)} · เงินรับสุทธิ ${fmtMoney(currentIncome - currentExpense)}`)}
      ${card("ขายดีเดือนนี้", best ? best.name : "ยังไม่มีการขาย", best ? `${best.qty} ชิ้น · ยอดขาย ${fmtMoney(best.revenue)} · กำไรตามการขาย ${fmtMoney(best.profit)}` : "บันทึกการขายแล้วระบบจะจัดอันดับสินค้าให้", best ? "ตรวจจำนวนคงเหลือของสินค้านี้ก่อนสั่งเติม" : "เริ่มบันทึกจากหน้าขายสินค้า")}
      ${card("สินค้ามือหนึ่งที่ควรตรวจสต็อก", `${refill.length} ตัวเลือก`, refill.length ? names(refill) : "ยังไม่มีสินค้ามือหนึ่งเหลือน้อยกว่าหรือเท่ากับเกณฑ์", refill.length ? "รวมสินค้าหมดและใกล้หมด เรียงจากยอดขายเดือนนี้มากไปน้อย" : "ระบบใช้เกณฑ์เหลือไม่เกิน " + LOW_STOCK_THRESHOLD + " ชิ้น")}
      ${card("สต็อกที่ไม่มีการขาย 60 วัน", fmtMoney(slowValue), slow.length ? `${slow.length} ตัวเลือก · ${names(slow)}` : "ยังไม่มีสินค้าที่เข้าเกณฑ์นี้", slow.length ? "ทบทวนรูป ราคา และการโปรโมทก่อนสั่งเพิ่ม" : "นับเฉพาะสินค้าที่เข้าสต็อกมาแล้วอย่างน้อย 60 วัน")}
      ${card("ยอดผ่อนที่ยังต้องติดตาม", fmtMoney(outstandingValue), `${outstanding.length} รายการค้างชำระ · เกินกำหนด ${overdue.length} รายการ (${fmtMoney(overdueValue)})`, overdue.length ? "เปิดหน้าผ่อนชำระเพื่อตรวจรายการที่เลยกำหนดก่อน" : outstanding.length ? "ตรวจวันครบกำหนดในหน้าผ่อนชำระ" : "ไม่มีลูกหนี้ค้างชำระในขณะนี้")}
      ${card("เงินที่จ่ายสำหรับของรอรับ", fmtMoney(pendingValue), `${pendingOrders.length} รายการ · ${pendingQty} ชิ้น`, pendingOrders.length ? "ตรวจสินค้าที่มาถึงแล้วและยืนยันรับของในหน้าสต็อกสินค้า" : "ไม่มีสินค้ารอรับในขณะนี้")}
    </div>
    ${
      ranked.length
        ? `<div style="margin-top:22px;"><h3>สินค้าขายดีเดือนนี้</h3><div class="table-wrap"><table><thead><tr><th>สินค้า</th><th class="num">ขายแล้ว</th><th class="num">ยอดขาย</th><th class="num">กำไรตามการขาย</th></tr></thead><tbody>${ranked
            .slice(0, 5)
            .map(
              (item) =>
                `<tr><td>${escapeHtml(item.name)}</td><td class="num">${item.qty} ชิ้น</td><td class="num">${fmtMoney(item.revenue)}</td><td class="num">${fmtMoney(item.profit)}</td></tr>`,
            )
            .join(
              "",
            )}</tbody></table></div><p class="hint" style="margin-top:12px;">ยอดขายและกำไรตามการขายรวมรายการผ่อนชำระที่ยังรับเงินไม่ครบ ส่วนรายรับนับเฉพาะเงินที่บันทึกว่ารับแล้ว</p></div>`
        : ""
    }
  `;
}

function wireAiTab() {
  const btn = document.getElementById("ai-run-btn");
  if (btn) btn.onclick = runAiAnalysis;
}

function runAiAnalysis() {
  const btn = document.getElementById("ai-run-btn");
  const resultBox = document.getElementById("ai-result");
  if (!btn || !resultBox) return;
  try {
    resultBox.innerHTML = renderLocalInsights();
    aiResult = true;
    btn.textContent = "อัปเดตผลวิเคราะห์";
  } catch (e) {
    console.error("Store analysis failed", e);
    resultBox.innerHTML =
      '<div class="ai-result">ยังสรุปข้อมูลไม่ได้ กรุณาลองใหม่อีกครั้ง</div>';
  }
}

new MutationObserver(() => enhanceUI()).observe(app, {
  childList: true,
  subtree: true,
});
if (tabMeta[location.hash.slice(1)]) activeTab = location.hash.slice(1);
window.addEventListener("hashchange", () => {
  if (tabMeta[location.hash.slice(1)]) navigateTo(location.hash.slice(1));
});
loadAll();

// ---------- Customer pre-orders (not supplier stock purchases) ----------
function preorderFields(order = {}) {
  const field = (name, label, type = "text", attrs = "", value = order[name] ?? "") =>
    `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${escapeHtml(String(value))}" ${attrs}></div>`;
  return `${field("customer", "ชื่อลูกค้า", "text", 'required maxlength="2000"')}
    ${field("contact", "ช่องทางติดต่อ / เบอร์โทร", "text", 'maxlength="2000"')}
    ${field("name", "สินค้าที่ลูกค้าสั่ง", "text", 'required maxlength="2000"')}
    ${field("color", "สี", "text", 'maxlength="2000"')}
    ${field("size", "ไซส์", "text", 'maxlength="2000"')}
    <div class="field"><label>สภาพสินค้า</label><select name="type"><option value="new">มือหนึ่ง</option><option value="used" ${order.type === "used" ? "selected" : ""}>มือสอง</option></select></div>
    ${field("qty", "จำนวน", "number", 'required min="1" step="1"', order.qty ?? 1)}
    ${field("unitPrice", "ราคาขายต่อชิ้น (บาท)", "number", 'required min="0.01" max="1000000000000" step="0.01"')}
    ${field("dueDate", "วันนัดส่ง (ไม่บังคับ)", "date")}
    ${field("note", "หมายเหตุ / ที่อยู่จัดส่ง", "text", 'maxlength="2000"')}`;
}
function renderPreordersTab() {
  const open = preorders.filter(preorderOpen);
  const overdue = open.filter(order => order.dueDate && order.dueDate < todayStr());
  const options = allVariants().map(({ product, variant }) => `<option value="${escapeHtml(variant.id)}">${escapeHtml(variantLabel(product, variant))} · เหลือ ${variant.qty}</option>`).join("");
  const sorted = [...preorders].sort((a, b) => Number(preorderOpen(b)) - Number(preorderOpen(a)) || String(a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.createdAt.localeCompare(a.createdAt));
  return `<section class="stats preorder-stats" aria-label="สรุป pre-order ลูกค้า">
    ${metric("รอส่งมอบ", open.length, "รายการที่ลูกค้าพรีกับร้าน", "bag")}
    ${metric("ยอดรอรับชำระ", fmtMoney(open.reduce((sum, order) => sum + preorderBalance(order), 0)), "เฉพาะ pre-order ที่ยังเปิดอยู่", "wallet")}
    ${metric("เกินวันนัดส่ง", overdue.length, "ควรติดต่อแจ้งลูกค้า", "clock", overdue.length ? "expense-stat" : "")}
    </section>
    <div class="panel preorder-intro"><h2>รับพรีจากลูกค้า</h2><p class="hint">ใช้เมื่อมีลูกค้าสั่งสินค้ากับร้าน รับเงินได้หลายครั้งและติดตามจนส่งมอบ ส่วนสินค้าที่ร้านซื้อมาเก็บขายเองให้ใช้ “สั่งซื้อรอรับของ” ในหน้าสต็อก</p><p class="hint">รับจองยังไม่หักหรือกันสต็อก ยอดมัดจำเข้าบัญชีเมื่อรับเงินจริง และนับยอดขาย/กำไรเมื่อส่งมอบเท่านั้น</p>
    <details id="preorder-create"><summary>+ เพิ่ม pre-order ลูกค้า</summary><form id="preorder-form"><div class="form-grid">${preorderFields()}<div class="field"><label>มัดจำที่รับแล้ว (บาท)</label><input name="deposit" type="number" min="0" step="0.01" value="0" required></div></div><p class="hint" id="preorder-quote" aria-live="polite">ระบุจำนวนและราคาต่อชิ้นเพื่อคำนวณยอด</p><button class="btn btn-primary" type="submit">บันทึก pre-order</button></form></details></div>
    <div class="panel"><div class="section-heading"><h2>รายการ pre-order ลูกค้า</h2></div><div class="preorder-filters"><div class="field"><label for="preorder-search">ค้นหาลูกค้า สินค้า หรือรหัสรายการ</label><input id="preorder-search" type="search" value="${escapeHtml(preorderSearch)}" placeholder="ชื่อลูกค้า เบอร์โทร สินค้า…"></div><div class="field"><label for="preorder-filter">สถานะ</label><select id="preorder-filter">${Object.entries({ open: "รายการที่ยังเปิดอยู่", all: "ทุกสถานะ", overdue: "เกินวันนัดส่ง", ...preorderStatuses }).map(([value, label]) => `<option value="${value}" ${preorderFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select></div><button id="preorder-clear" class="btn btn-ghost" type="button">ล้างตัวกรอง</button></div><p class="hint" id="preorder-count" role="status"></p>
    <div class="preorder-list">${sorted.map(order => {
      const isOpen = preorderOpen(order), late = isOpen && order.dueDate && order.dueDate < todayStr();
      const id = escapeHtml(order.id);
      const cash = transactions.filter(tx => tx.preorderId === order.id && ["income", "expense"].includes(tx.type));
      return `<article class="preorder-card ${late ? "preorder-late" : ""}" data-preorder="${id}">
        <div class="preorder-heading"><div><p class="eyebrow">PO · ${id}</p><h3>${escapeHtml(order.customer)}</h3><p>${escapeHtml(order.name)} · ${escapeHtml([order.color, order.size, order.type === "used" ? "มือสอง" : "มือหนึ่ง"].filter(Boolean).join(" / "))} ×${order.qty}</p></div><span class="tag ${order.status === "completed" ? "income" : order.status === "cancelled" ? "expense" : "preorder"}">${preorderStatuses[order.status]}</span></div>
        <p class="hint">${escapeHtml(order.contact || "ไม่ได้ระบุช่องทางติดต่อ")} · รับจอง ${order.createdAt} · นัดส่ง ${order.dueDate || "ยังไม่ระบุ"}${late ? " · เกินกำหนดนัดส่ง" : ""}</p>
        ${order.note ? `<p class="preorder-note">${escapeHtml(order.note)}</p>` : ""}
        <div class="preorder-totals"><span>ยอดสั่งซื้อ<strong>${fmtMoney(preorderTotal(order))}</strong></span><span>รับแล้ว<strong>${fmtMoney(order.paidAmount)}</strong></span><span>${order.status === "cancelled" ? "คืนเงินแล้ว" : "ค้างชำระ"}<strong>${fmtMoney(order.status === "cancelled" ? order.refundedAmount : preorderBalance(order))}</strong></span></div>
        ${isOpen ? `<div class="preorder-actions">${order.status !== "ready" ? `<button class="btn btn-primary btn-sm" data-preorder-action="status">${order.status === "awaiting" ? "ยืนยันว่าสั่งให้ลูกค้าแล้ว" : "สินค้าพร้อมส่งมอบแล้ว"}</button>` : ""}<button class="btn btn-ghost btn-sm danger-text" data-preorder-action="cancel">ยกเลิก${order.paidAmount ? "และบันทึกคืนเงิน" : "รายการ"}</button></div>
        ${preorderBalance(order) > 0 ? `<form class="preorder-payment preorder-inline"><div class="field"><label>รับชำระเพิ่ม (บาท)</label><input name="amount" type="number" min="0.01" max="${preorderBalance(order)}" step="0.01" required></div><button class="btn btn-primary btn-sm" type="submit">บันทึกรับเงิน</button></form>` : '<p class="hint">ชำระครบแล้ว</p>'}
        <details><summary>แก้ไขข้อมูลการจอง</summary><form class="preorder-edit"><div class="form-grid">${preorderFields(order)}</div><p class="hint">ยอดสั่งซื้อใหม่ต้องไม่น้อยกว่ายอดที่รับเงินแล้ว</p><button class="btn btn-ghost" type="submit">บันทึกการแก้ไข</button></form></details>
        ${order.status === "ready" ? `<details class="preorder-delivery"><summary>ส่งมอบสินค้าและปิดรายการ</summary><form class="preorder-fulfill"><p class="hint">ต้องรับเงินครบก่อนส่งมอบ การส่งมอบจะบันทึกยอดขายและกำไร โดยไม่รับเงินซ้ำ</p><div class="form-grid"><div class="field"><label>วิธีส่งมอบ</label><select name="source"><option value="direct">ของที่จัดหาเฉพาะลูกค้า (ไม่ผ่านสต็อก)</option><option value="stock">นำสินค้าจากสต็อกของร้าน</option></select></div><div class="field preorder-stock-field" hidden><label>สินค้าที่ตัดสต็อก</label><select name="variantId" disabled required><option value="">เลือกสินค้า สี และไซส์ให้ตรงกับรายการจอง</option>${options}</select></div><div class="field preorder-direct-field"><label>ต้นทุนจริงต่อชิ้น (บาท)</label><input name="unitCost" type="number" min="0" step="0.01" required></div><div class="field"><label>ค่าส่งที่ร้านจ่าย (บาท)</label><input name="shipping" type="number" min="0" step="0.01" value="0" required></div><div class="field"><label>ค่ากลาง (บาท)</label><input name="commission" type="number" min="0" step="0.01" value="0" required></div></div><label class="preorder-cost-check preorder-direct-field"><input type="checkbox" name="costRecorded"> บันทึกรายจ่ายต้นทุนสินค้านี้ในบัญชีไปแล้ว</label><p class="hint">หากยังไม่เคยลงต้นทุน ระบบจะลงรายจ่ายวันนี้เมื่อส่งมอบ ค่าส่งและค่ากลางจะลงเพิ่มตามจำนวนที่ระบุ</p><button type="submit" class="btn btn-primary">ยืนยันส่งมอบสินค้า</button></form></details>` : ""}` : ""}
        ${cash.length ? `<details><summary>ประวัติรับเงินและค่าใช้จ่าย (${cash.length})</summary><ul class="preorder-history">${cash.map(tx => `<li><span>${escapeHtml(tx.date)} · ${escapeHtml(tx.category)}</span><strong>${tx.type === "income" ? "+" : "−"}${fmtMoney(tx.amount)}</strong></li>`).join("")}</ul></details>` : ""}
      </article>`;
    }).join("")}</div><div class="empty" id="preorder-empty" hidden><div class="big">ไม่พบรายการ pre-order</div>เพิ่มรายการใหม่ หรือลองเปลี่ยนคำค้นหาและสถานะ</div></div>`;
}
async function performPreorderAction(id, action, data = {}) {
  if (savingStores.size) return;
  try {
    const reviewedOrder = ["cancel", "fulfill"].includes(action)
      ? copyData(preorders.find(item => item.id === id) || null)
      : null;
    if (action === "cancel") {
      const order = preorders.find(item => item.id === id);
      if (!order || !preorderOpen(order)) return;
      if (!(await showConfirm(`ยกเลิก pre-order ของ ${order.customer}${order.paidAmount ? ` และยืนยันว่าได้คืนเงินลูกค้า ${fmtMoney(order.paidAmount)} แล้ว` : ""}? ระบบจะเก็บประวัติรายการไว้`))) return;
    }
    if (action === "fulfill" && !(await showConfirm("ยืนยันส่งมอบสินค้าให้ลูกค้าแล้ว? ระบบจะบันทึกยอดขาย ต้นทุน และตัดสต็อกตามวิธีที่เลือก"))) return;
    if (reviewedOrder && JSON.stringify(reviewedOrder) !== JSON.stringify(preorders.find(item => item.id === id))) {
      showAlert("รายการเปลี่ยนแปลงระหว่างยืนยัน กรุณาเปิดรายการล่าสุดและตรวจยอดอีกครั้ง");
      return;
    }
    // Work on a copy so validation cannot partially mutate the live store.
    const next = copyData(storeValues());
    const context = { uid, today: todayStr(), validDate: validDateString };
    if (action === "create") createPreorder(next, data, context);
    else updatePreorder(next, id, action, data, context);
    const names = action === "fulfill" ? ["preorders", "transactions", "products"] : ["preorders", "transactions"];
    names.forEach(name => assignStore(name, next[name]));
    await saveData(...names);
    if (action === "create") { preorderSearch = ""; preorderFilter = "open"; }
    render();
  } catch (error) {
    if (!error.storageReported) showAlert(error.message || "ดำเนินการไม่สำเร็จ");
  }
}
function wirePreordersTab() {
  const form = document.getElementById("preorder-form");
  if (!form) return;
  form.onsubmit = event => { event.preventDefault(); performPreorderAction(null, "create", Object.fromEntries(new FormData(form))); };
  form.oninput = () => {
    const data = Object.fromEntries(new FormData(form));
    const total = Number(data.qty) * Number(data.unitPrice), deposit = Number(data.deposit || 0);
    document.getElementById("preorder-quote").textContent = Number.isFinite(total) && total > 0 ? `ยอดสั่งซื้อ ${fmtMoney(total)} · ค้างชำระ ${fmtMoney(Math.max(0, total - deposit))}${deposit > total ? " · มัดจำเกินยอดสั่งซื้อ" : ""}` : "ระบุจำนวนและราคาต่อชิ้นเพื่อคำนวณยอด";
  };
  const search = document.getElementById("preorder-search"), filter = document.getElementById("preorder-filter");
  const applyFilters = () => {
    preorderSearch = search.value; preorderFilter = filter.value;
    let count = 0;
    document.querySelectorAll("[data-preorder]").forEach(card => {
      const order = preorders.find(item => item.id === card.dataset.preorder);
      const matches = normalizedText([order.id, order.customer, order.contact, order.name, order.color, order.size, order.note].join(" ")).includes(normalizedText(preorderSearch)) &&
        (preorderFilter === "all" || (preorderFilter === "open" ? preorderOpen(order) : preorderFilter === "overdue" ? preorderOpen(order) && order.dueDate && order.dueDate < todayStr() : order.status === preorderFilter));
      card.hidden = !matches; if (matches) count++;
    });
    document.getElementById("preorder-count").textContent = `แสดง ${count} จาก ${preorders.length} รายการ`;
    document.getElementById("preorder-empty").hidden = count > 0;
  };
  search.oninput = filter.onchange = applyFilters;
  document.getElementById("preorder-clear").onclick = () => { search.value = ""; filter.value = "all"; applyFilters(); };
  applyFilters();
  document.querySelectorAll("[data-preorder]").forEach(card => {
    const id = card.dataset.preorder;
    card.querySelectorAll("[data-preorder-action]").forEach(button => { button.onclick = () => performPreorderAction(id, button.dataset.preorderAction); });
    for (const [selector, action] of [[".preorder-payment", "pay"], [".preorder-edit", "edit"], [".preorder-fulfill", "fulfill"]]) {
      const actionForm = card.querySelector(selector);
      if (actionForm) actionForm.onsubmit = event => { event.preventDefault(); performPreorderAction(id, action, Object.fromEntries(new FormData(actionForm))); };
    }
    const source = card.querySelector('[name="source"]');
    if (source) source.onchange = () => {
      card.querySelectorAll(".preorder-stock-field, .preorder-direct-field").forEach(field => {
        const visible = field.classList.contains("preorder-stock-field") === (source.value === "stock");
        field.hidden = !visible;
        field.querySelectorAll("input,select").forEach(input => { input.disabled = !visible; });
      });
    };
  });
}

// ---------- Follow-ups and portable reports ----------
let taskSearch = "";
let taskFilter = "all";
let reportFrom = "";
let reportTo = "";
const taskKinds = { shipment: "ขายแล้วรอส่ง", ads: "แคมเปญยิงแอด", stock: "สต็อกใกล้หมด", supplier: "ร้านสั่งรอรับ", preorder: "Pre-order ลูกค้า", installment: "ผ่อนค้างชำระ" };
function renderTasksTab() {
  const items = followUpItems(storeValues(), todayStr(), LOW_STOCK_THRESHOLD);
  return `<section class="stats tasks-stats">${metric("งานทั้งหมด", items.length, "อัปเดตจากรายการปัจจุบัน", "check")}${metric("ควรจัดการก่อน", items.filter(item => item.priority === 0).length, "สินค้าหมด เกินวันนัด หรือแอดเกินงบ", "clock", "expense-stat")}</section>
    <div class="panel"><h2>งานที่ต้องติดตาม</h2><p class="hint">สินค้ารอรับคือร้านสั่งมาขายเอง ส่วน pre-order คือรายการที่ลูกค้าสั่งกับร้าน วันที่ในรายการรอรับเป็นวันสั่งซื้อ ส่วนรายการลูกค้าเป็นวันครบกำหนด</p>
    <div class="task-filters"><div class="field"><label>ค้นหางาน</label><input id="task-search" type="search" value="${escapeHtml(taskSearch)}" placeholder="สินค้า ลูกค้า หรือหมายเหตุ"></div><div class="field"><label>ประเภทงาน</label><select id="task-filter">${Object.entries({ all: "ทุกประเภท", urgent: "ควรจัดการก่อน", ...taskKinds }).map(([key, label]) => `<option value="${key}" ${taskFilter === key ? "selected" : ""}>${label}</option>`).join("")}</select></div></div><p class="hint" id="task-count" role="status"></p>
    <div class="task-list">${items.map(item => `<article class="task-card" data-task-kind="${item.kind}" data-task-priority="${item.priority}"><div><span class="tag ${item.priority === 0 ? "expense" : "preorder"}">${taskKinds[item.kind]}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p>${item.date ? `<p class="hint">${item.kind === "supplier" ? "สั่งเมื่อ" : item.kind === "shipment" ? "ขายเมื่อ" : "ครบกำหนด"} ${escapeHtml(item.date)}</p>` : ""}</div><button class="btn btn-ghost" data-task-target="${item.target}" data-task-id="${escapeHtml(item.id)}" data-task-workspace="${item.workspace || ""}">เปิดรายการ</button></article>`).join("")}</div><div class="empty" id="task-empty" hidden>ไม่มีงานที่ตรงกับตัวกรอง</div></div>`;
}
function wireTasksTab() {
  const search = document.getElementById("task-search"), filter = document.getElementById("task-filter");
  if (!search) return;
  const apply = () => {
    taskSearch = search.value; taskFilter = filter.value;
    let count = 0;
    document.querySelectorAll("[data-task-kind]").forEach(card => {
      const match = normalizedText(card.textContent).includes(normalizedText(taskSearch)) && (taskFilter === "all" || (taskFilter === "urgent" ? card.dataset.taskPriority === "0" : card.dataset.taskKind === taskFilter));
      card.hidden = !match; if (match) count++;
    });
    document.getElementById("task-count").textContent = `แสดง ${count} งาน`;
    document.getElementById("task-empty").hidden = count > 0;
  };
  search.oninput = filter.onchange = apply;
  apply();
  document.querySelectorAll("[data-task-target]").forEach(button => {
    button.onclick = () => {
      const { taskTarget: target, taskId: id, taskWorkspace: workspace } = button.dataset;
      if (target === "preorder") { preorderSearch = id; preorderFilter = "open"; }
      if (workspace === "inventory") inventorySearch = findVariant(id)?.product.name || "";
      navigateTo(target, workspace);
      if (target === "ads") {
        document.getElementById('ad-search').value = '';
        document.getElementById('ad-filter').value = 'all';
        document.getElementById('ad-filter').dispatchEvent(new Event('change'));
        const campaignCard = [...document.querySelectorAll('[data-ad-id]')].find(card => card.dataset.adId === id);
        if (campaignCard) { campaignCard.scrollIntoView({block:'start'}); campaignCard.querySelector('button')?.focus({preventScroll:true}); }
      }
      if (target === "shipments") { const search = document.getElementById("shipment-search"); search.value = id; search.dispatchEvent(new Event("input")); }
      const trigger = [...document.querySelectorAll('[data-pay], [data-pending-id], [data-edit]')].find(el => (el.dataset.pay || el.dataset.pendingId || el.dataset.edit) === id);
      if (trigger) { trigger.scrollIntoView({ block: "center" }); trigger.focus({ preventScroll: true }); }
    };
  });
}
function downloadCsv(name, rows) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `crazsix-${name}-${todayStr()}.csv`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("ส่งออก CSV แล้ว");
}
function transactionExportRows(rows) {
  return [["รหัส", "วันที่", "ประเภท", "หมวดหมู่", "รายละเอียด", "ยอดรายการ", "เงินรับจริง", "เงินจ่ายจริง", "จำนวนขาย", "กำไรขายก่อนแอด", "รหัส pre-order", "รหัสแคมเปญแอด"], ...rows.map(tx => [tx.id, tx.date, tx.type, tx.category, tx.desc, tx.amount, tx.type === "income" ? tx.amount : 0, tx.type === "expense" ? tx.amount : 0, tx.qty || 0, tx.profit ?? "", tx.preorderId || "", tx.adCampaignId || ""])];
}
function wireExportTools() {
  document.querySelectorAll("[data-export]").forEach(button => {
    button.onclick = () => {
      const kind = button.dataset.export;
      if (kind === "inventory") downloadCsv(kind, [["รหัสสินค้า", "รหัสตัวเลือก", "สินค้า", "สี", "ไซส์", "อก (นิ้ว)", "ความยาว (นิ้ว)", "สภาพ", "คงเหลือ", "ต้นทุนต่อชิ้น", "ราคาขาย", "มูลค่าสต็อก"], ...allVariants().map(({product, variant: v}) => [product.id, v.id, product.name, v.color, v.size, v.chestInches ?? "", v.lengthInches ?? "", v.type, v.qty, v.cost, v.price, money(v.qty * v.cost)])]);
      else if (kind === "preorders") downloadCsv(kind, [["รหัส", "ลูกค้า", "ติดต่อ", "สินค้า", "สี", "ไซส์", "จำนวน", "ยอดรวม", "รับแล้ว", "คืนแล้ว", "ค้างชำระ", "สถานะ", "วันนัดส่ง", "หมายเหตุ"], ...preorders.map(o => [o.id, o.customer, o.contact, o.name, o.color, o.size, o.qty, preorderTotal(o), o.paidAmount, o.refundedAmount, preorderBalance(o), preorderStatuses[o.status], o.dueDate, o.note])]);
      else {
        let rows = transactions;
        if (kind === "filtered-transactions") rows = rows.filter(tx => (!txSearch || normalizedText([tx.desc, tx.category, tx.date].join(" ")).includes(normalizedText(txSearch))) && (txTypeFilter === "all" || tx.type === txTypeFilter) && (!txMonthFilter || tx.date.startsWith(txMonthFilter)));
        downloadCsv(kind, transactionExportRows(rows));
      }
    };
  });
}
function renderRangeReport() {
  return `<div class="panel"><h2>รายงานตามช่วงวันที่</h2><div class="task-filters"><div class="field"><label>ตั้งแต่วันที่</label><input id="report-from" type="date" value="${reportFrom}"></div><div class="field"><label>ถึงวันที่</label><input id="report-to" type="date" value="${reportTo}"></div><button class="btn btn-ghost" id="report-clear">ทุกช่วงเวลา</button><button class="btn btn-primary" id="report-export">ส่งออกช่วงนี้ CSV</button></div><p class="hint" id="report-range-error" role="status"></p><div id="report-range-summary" class="stats range-stats"></div><p class="hint">เงินสดสุทธิคิดตามวันที่รับ/จ่ายจริง กำไรจากการขายคิดเฉพาะยอดขายในช่วงนี้ หักต้นทุนสินค้า ค่าส่ง และค่ากลางแล้ว กำไรหลังแอดหักค่าแอดที่จ่ายในช่วงวันที่เลือกอีกครั้งหนึ่งจากกำไรขาย ยังไม่หักค่าใช้จ่ายทั่วไปของร้าน ตารางและกราฟด้านล่างแสดงกำไรก่อนค่าแอดและเป็นภาพรวมทุกช่วงเวลา</p></div>`;
}
function wireRangeReport() {
  const from = document.getElementById("report-from"), to = document.getElementById("report-to");
  if (!from) return;
  const update = () => {
    reportFrom = from.value; reportTo = to.value;
    const valid = (!reportFrom || validDateString(reportFrom)) && (!reportTo || validDateString(reportTo)) && (!reportFrom || !reportTo || reportFrom <= reportTo);
    document.getElementById("report-range-error").textContent = valid ? "" : "วันที่เริ่มต้นต้องไม่อยู่หลังวันที่สิ้นสุด";
    document.getElementById("report-export").disabled = !valid;
    const summary = document.getElementById("report-range-summary");
    if (!valid) { summary.innerHTML = ""; return null; }
    const stats = cashSummary(transactions, reportFrom, reportTo);
    summary.innerHTML = metric("เงินรับจริง", fmtMoney(stats.income), `${stats.rows.length} รายการในช่วงนี้`, "up") + metric("เงินจ่ายจริง", fmtMoney(stats.expense), "ต้นทุนซื้อเข้าและค่าใช้จ่าย", "down") + metric("เงินสดสุทธิ", fmtMoney(stats.cash), "เงินรับ − เงินจ่าย", "wallet") + metric("กำไรจากการขาย", fmtMoney(stats.profit), `ขาย ${stats.qty} ชิ้น · ยอดขาย ${fmtMoney(stats.sales)} · ก่อนค่าแอด`, "chart") + metric("ค่าแอดจ่ายในช่วงนี้", fmtMoney(stats.rows.filter(isAdSpend).reduce((sum,tx) => sum + tx.amount,0)), "รวมทุกแคมเปญตามวันที่จ่าย", "down") + metric("กำไรขายหลังหักแอด", fmtMoney(stats.profit - stats.rows.filter(isAdSpend).reduce((sum,tx) => sum + tx.amount,0)), "ค่าแอดลงเงินจ่ายจริงแล้ว ไม่หักเงินสดซ้ำ", "wallet");
    return stats;
  };
  from.onchange = to.onchange = update;
  document.getElementById("report-clear").onclick = () => { from.value = ""; to.value = ""; update(); };
  document.getElementById("report-export").onclick = () => { const stats = update(); if (stats) downloadCsv("report", transactionExportRows(stats.rows)); };
  update();
}

// ---------- Physical stock counts ----------
function renderStocktake() {
  const variants = allVariants();
  const history = variants.flatMap(({ product, variant }) => (variant.adjustments || []).map(entry => ({ ...entry, label: variantLabel(product, variant) }))).sort((a,b) => b.date.localeCompare(a.date));
  return `<h2>ตรวจนับและปรับยอดสต็อก</h2><p class="hint">ใช้เมื่อนับของจริงแล้วไม่ตรงกับระบบ ต้องระบุเหตุผล ระบบเก็บยอดก่อน–หลังและคงต้นทุนต่อชิ้นเดิม การปรับยอดนี้ไม่ใช่การซื้อ/ขายและไม่ลงบัญชีอัตโนมัติ</p>
    <form id="stocktake-form"><div class="form-grid"><div class="field"><label>ค้นหาสินค้าที่ตรวจนับ</label><input id="stocktake-search" type="search" placeholder="ชื่อสินค้า สี หรือไซส์"></div><div class="field"><label>สินค้า / สี / ไซส์</label><select name="variantId" required><option value="">เลือกสินค้าที่ตรวจนับ</option>${variants.map(({product,variant}) => `<option value="${escapeHtml(variant.id)}">${escapeHtml(variantLabel(product,variant))}</option>`).join("")}</select></div><div class="field"><label>จำนวนที่นับได้จริง</label><input name="actual" type="number" min="0" step="1" required></div><div class="field"><label>เหตุผลการปรับยอด</label><input name="reason" maxlength="500" required placeholder="เช่น ของเสียหาย / ตรวจนับปลายเดือน"></div></div><p class="hint" id="stocktake-preview" role="status">เลือกสินค้าเพื่อดูยอดปัจจุบัน</p><button type="submit" class="btn btn-primary">บันทึกผลตรวจนับ</button></form>
    <h3>ประวัติปรับยอดตรวจนับ</h3><p class="hint">รวมการเปลี่ยนจำนวนจากหน้าแก้ไขสินค้า เก็บอยู่กับตัวเลือกสินค้าและอยู่ในไฟล์สำรอง JSON เมื่อลบตัวเลือกสินค้า ประวัติของตัวเลือกนั้นจะถูกลบด้วย</p>
    ${history.length ? `<table><thead><tr><th>เวลา</th><th>สินค้า</th><th>ก่อน</th><th>หลัง</th><th>ผลต่าง</th><th>เหตุผล</th></tr></thead><tbody>${history.map(entry => `<tr><td>${escapeHtml(new Date(entry.date).toLocaleString("th-TH"))}</td><td>${escapeHtml(entry.label)}</td><td>${entry.before}</td><td>${entry.after}</td><td>${entry.delta > 0 ? "+" : ""}${entry.delta}</td><td>${escapeHtml(entry.reason)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">ยังไม่มีประวัติปรับยอดตรวจนับ</div>'}`;
}
function wireStocktake() {
  const form = document.getElementById("stocktake-form");
  if (!form) return;
  const select = form.elements.namedItem("variantId"), actual = form.elements.namedItem("actual");
  let expected = null;
  const preview = () => {
    const parsed = Number(actual.value);
    document.getElementById("stocktake-preview").textContent = expected == null ? "เลือกสินค้าเพื่อดูยอดปัจจุบัน" : `ในระบบ ${expected} ชิ้น${actual.value !== "" && Number.isSafeInteger(parsed) && parsed >= 0 ? ` → นับได้ ${parsed} ชิ้น · ผลต่าง ${parsed - expected > 0 ? "+" : ""}${parsed - expected}` : ""}`;
  };
  select.onchange = () => { expected = findVariant(select.value)?.variant.qty ?? null; actual.value = ""; preview(); };
  actual.oninput = preview;
  document.getElementById("stocktake-search").oninput = event => {
    const q = normalizedText(event.target.value);
    for (const option of select.options) option.hidden = Boolean(option.value && option.value !== select.value && !normalizedText(option.textContent).includes(q));
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (savingStores.size) return;
    try {
      const found = findVariant(select.value);
      if (!found || actual.value === "") throw new Error("กรุณาเลือกสินค้าและระบุจำนวนที่นับได้");
      const entry = stockAdjustment(found.variant, Number(actual.value), expected, form.elements.namedItem("reason").value, uid(), new Date().toISOString());
      found.variant.adjustments = [...(found.variant.adjustments || []), entry];
      found.variant.qty = entry.after;
      await saveProducts();
      render();
    } catch (error) {
      if (!error.storageReported) showAlert(error.message || "บันทึกผลตรวจนับไม่สำเร็จ");
    }
  };
}


// ---------- Advertising workspace ----------
function wireAdsTab() {
  wireAds(copyData(storeValues()), {
    today: todayStr(), fmt: fmtMoney, confirm: showConfirm, alert: showAlert, csv: downloadCsv,
    openProduct: openProductAggDetail,
    commit: async action => {
      if (savingStores.size) return;
      const next = applyAdAction(storeValues(), action, uid(), todayStr());
      adCampaigns = next.adCampaigns;
      adWallet = next.adWallet;
      transactions = next.transactions;
      await saveData("adCampaigns", "transactions", "products", "adWallet");
      render();
    },
  });
}
function renderProductAds(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return "";
  const m = productAdMetrics(product, adCampaigns, transactions, todayStr());
  return `<section class="product-ad-detail"><h3>ค่าแอดของสินค้า (รวมทุกสี/ไซส์)</h3><p>ผูก ${m.linked.length} แคมเปญ · ค่าแอดจ่ายจริง ${fmtMoney(m.spend)}</p><p><strong>กำไรสินค้าหลังหักแอด ${fmtMoney(m.net)}</strong></p><p class="hint">ยอดขายทั้งหมดของสินค้านี้ ก่อนแอด ${fmtMoney(m.profit)} − ค่าแอด ${fmtMoney(m.spend)} · งบต่อชิ้นสำหรับวางราคา ${fmtMoney(m.plannedPerUnit)} จากแคมเปญที่เปิดใช้งานหรือยังไม่เริ่ม ต้นทุนซื้อในสต็อกยังคงเดิม</p><button class="btn btn-ghost" data-product-ads="${escapeHtml(product.id)}">จัดการแอดของสินค้านี้</button></section>`;
}
function wireProductAds() {
  document.querySelectorAll('[data-product-ads]').forEach(button => button.onclick = () => {
    const id = button.dataset.productAds;
    closeDetail(); navigateTo('ads');
    document.getElementById('ad-search').value = products.find(p => p.id === id)?.name || '';
    document.getElementById('ad-filter').value = 'all';
    document.getElementById('ad-filter').dispatchEvent(new Event('change'));
    const form = document.getElementById('ad-create-form');
    if (form) { form.elements.namedItem('productId').value = id; form.elements.namedItem('productId').dispatchEvent(new Event('change', {bubbles:true})); }
    const card = [...document.querySelectorAll('[data-ad-id]')].find(card => adCampaigns.some(c => c.id === card.dataset.adId && campaignHasProduct(c, id)));
    if (card && !card.hidden) card.scrollIntoView({block:'start'});
    else document.getElementById('ad-create').open = true;
  });
}

function updateReportChartTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const colors = getComputedStyle(document.documentElement);
  const text = colors.getPropertyValue('--ink-soft').trim();
  const grid = colors.getPropertyValue('--line').trim();
  for (const chart of [trendChartInstance, sellersChartInstance]) {
    if (!chart) continue;
    chart.options.color = text;
    if (chart.options.plugins.legend) chart.options.plugins.legend.labels.color = text;
    for (const axis of Object.values(chart.options.scales)) {
      axis.ticks.color = text;
      axis.grid.color = grid;
      axis.border.color = grid;
    }
    if (chart === trendChartInstance) {
      chart.data.datasets.forEach((dataset, index) => {
        dataset.borderColor = (dark ? ['#76b9a2', '#dc8e9d', '#a2afe8'] : ['#1f8a5c', '#d1435b', '#16214a'])[index];
        dataset.backgroundColor = dataset.borderColor + '18';
      });
    } else chart.data.datasets[0].backgroundColor = dark ? '#8799d4' : '#37448c';
    chart.update('none');
  }
}
window.addEventListener('themechange', updateReportChartTheme);

function wireShipmentsTab() {
  wireShipments(copyData(storeValues()), {confirm:showConfirm, alert:showAlert, csv:downloadCsv, commit:async action=>{
    if (savingStores.size) return;
    const next = applyShipmentAction(storeValues(),action,uid(),todayStr());
    transactions = next.transactions; shipments = next.shipments;
    await saveData("transactions","shipments");
    render();
    toast(action.type === "ship" ? "บันทึกส่งสินค้าแล้ว" : "คืนรายการเข้ารอส่งแล้ว");
  }});
}
