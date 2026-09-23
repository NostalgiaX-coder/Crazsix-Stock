// Dialog focus stays inside the active dialog and returns to its trigger on close.
const overlays = [...document.querySelectorAll(".modal-overlay")];
const previousFocus = new Map();
const focusable =
  'button:not(:disabled),a[href],input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
let lastDialog = null;
function shownDialog() {
  return document.getElementById("modal-overlay").classList.contains("show")
    ? document.getElementById("modal-overlay")
    : overlays.filter((el) => el.classList.contains("show")).at(-1);
}
function visibleControls(dialog) {
  return [...dialog.querySelectorAll(focusable)].filter(
    (el) =>
      el.getClientRects().length &&
      getComputedStyle(el).visibility !== "hidden",
  );
}
function updateDialogs() {
  const active = shownDialog();
  let returnFocus = null;
  overlays.forEach((overlay) => {
    const open = overlay.classList.contains("show");
    overlay.setAttribute("aria-hidden", String(!open));
    overlay.inert = !open || overlay !== active;
    overlay.style.zIndex = overlay === active ? "1010" : "1000";
    if (open && !previousFocus.has(overlay))
      previousFocus.set(overlay, document.activeElement);
    if (!open && previousFocus.has(overlay)) {
      const target = previousFocus.get(overlay);
      previousFocus.delete(overlay);
      if (target?.isConnected) returnFocus = target;
    }
  });
  const app = document.getElementById("app");
  app.inert = Boolean(active);
  document.body.style.overflow = active ? "hidden" : "";
  if (returnFocus && (!active || active.contains(returnFocus))) {
    returnFocus.focus({ preventScroll: true });
  } else if (active && active !== lastDialog) {
    const controls = visibleControls(active);
    (
      controls.find((el) => el.id?.includes("cancel")) ||
      controls[0] ||
      active.querySelector("[role=dialog]")
    ).focus({ preventScroll: true });
  }
  lastDialog = active;
}
overlays.forEach((overlay) =>
  new MutationObserver(updateDialogs).observe(overlay, {
    attributes: true,
    attributeFilter: ["class"],
  }),
);
document.addEventListener("keydown", (event) => {
  const dialog = shownDialog();
  if (!dialog) return;
  if (event.key === "Escape") {
    event.preventDefault();
    const close =
      dialog.querySelector('[id$="cancel-btn"]') ||
      dialog.querySelector("#detail-close-btn,#modal-ok-btn");
    close?.click();
  }
  if (event.key === "Tab") {
    const controls = visibleControls(dialog);
    const first = controls[0],
      last = controls.at(-1);
    if (!first) {
      event.preventDefault();
      return;
    }
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
updateDialogs();

function updateConnection() {
  const badge = document.querySelector(".sync-status");
  if (!badge) return;
  const busy =
    document.getElementById("app").getAttribute("aria-busy") === "true";
  badge.innerHTML = `<span class="online-dot" style="${!navigator.onLine ? "background:#caa475" : ""}"></span>${!navigator.onLine ? "ออฟไลน์" : busy ? "กำลังบันทึก…" : "เชื่อมต่อแล้ว"}`;
  badge.setAttribute("role", "status");
}
window.addEventListener("online", updateConnection);
window.addEventListener("offline", updateConnection);
new MutationObserver(updateConnection).observe(document.getElementById("app"), {
  attributes: true,
  attributeFilter: ["aria-busy"],
  childList: true,
});
