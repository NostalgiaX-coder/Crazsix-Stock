// Apply before styles and body load so returning users never see a light flash.
(() => {
  const key = 'crazsix-theme';
  const root = document.documentElement;
  const normalize = value => value === 'light' ? 'light' : 'dark';
  function updateButton() {
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const dark = root.dataset.theme === 'dark';
    button.setAttribute('aria-pressed', String(dark));
    button.setAttribute('aria-label', dark ? 'เปลี่ยนเป็นโหมดสว่าง' : 'เปลี่ยนเป็นโหมดมืด');
    button.title = button.getAttribute('aria-label');
    button.querySelector('.theme-toggle-label').textContent = dark ? 'โหมดมืด' : 'โหมดสว่าง';
  }
  function apply(value) {
    const theme = normalize(value);
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#12171f' : '#edf0f7');
    updateButton();
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  }
  let saved;
  try { saved = localStorage.getItem(key); } catch { /* Still works with storage disabled. */ }
  apply(saved);
  document.addEventListener('click', event => {
    if (!event.target.closest('#theme-toggle')) return;
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(key, theme); } catch { /* Keep the current session usable. */ }
    apply(theme);
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) apply(event.newValue);
  });
})();
