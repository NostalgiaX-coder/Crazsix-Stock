import { reconcileAutomaticAds, dailyAdSpend, adWalletMetrics, campaignProductIds, campaignHasProduct, campaignUntilBudget, adSpendAllocations, adStatuses, adMetrics, campaignPhase, safeAdUrl, saleMatchesProduct } from './ads.js';
const phaseLabels = { ...adStatuses, scheduled: 'ยังไม่ถึงวันเริ่ม', ended: 'ครบกำหนดแล้ว', exhausted: 'เครดิตหมดแล้ว' };
let searchText = '', statusFilter = 'all';
const expandedCampaigns = new Set();
const number = (name, label, value, min = 0, step = '0.01', max = '') => `<div class="field"><label>${label}</label><input name="${name}" type="number" min="${min}" step="${step}" ${max ? `max="${max}"` : ''} value="${value}" required></div>`;
function campaignFields(c, products, today, esc) {
  return `<div class="form-grid ad-form-grid">
    <div class="field"><label>ชื่อแคมเปญ</label><input name="name" maxlength="120" value="${esc(c?.name || '')}" placeholder="เช่น เสื้อรุ่นใหม่ รอบเดือนนี้" required></div>
    <div class="field"><label>สินค้าแรก (รวมทุกสี/ไซส์)</label><select name="productId" required><option value="">เลือกสินค้า</option>${products.map(p => `<option value="${esc(p.id)}" ${c?.productId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <fieldset class="ad-product-picker ad-wide"><legend>แนบสินค้าเพิ่มเติมในแคมเปญเดียวกัน</legend><div class="ad-product-options">${products.map(p => `<label><input type="checkbox" name="extraProductId" value="${esc(p.id)}" ${campaignProductIds(c).slice(1).includes(p.id) ? 'checked' : ''}><span>${esc(p.name)}</span></label>`).join('')}</div><p class="hint">ค่าแอดแต่ละครั้งแบ่งเท่ากันระหว่างสินค้าที่แนบ เศษสตางค์จัดให้ยอดรวมตรงกับที่จ่าย การเพิ่มสินค้าใหม่ไม่เปลี่ยนส่วนแบ่งค่าแอดเก่า</p></fieldset>
    <div class="field"><label>ช่องทางโฆษณา</label><input name="channel" list="ad-channels" maxlength="80" value="${esc(c?.channel || 'Facebook / Instagram')}" required></div>
    <div class="field"><label>สถานะ</label><select name="status">${Object.entries(adStatuses).map(([key, label]) => `<option value="${key}" ${(c?.status || 'active') === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="field"><label>ระยะเวลายิงแอด</label><select name="runMode"><option value="until_budget" ${!c || campaignUntilBudget(c) ? 'selected' : ''}>ยิงต่อเนื่องจนเครดิตหมด (ไม่กำหนดวันหยุด)</option><option value="dated" ${c && !campaignUntilBudget(c) ? 'selected' : ''}>กำหนดวันสิ้นสุด</option></select></div>
    <div class="field"><label>วันเริ่มยิงแอด</label><input name="startDate" type="date" value="${c?.startDate || today}" required></div>
    <div class="field ad-end-field"><label>วันสิ้นสุด (รวมวันนี้)</label><input name="endDate" type="date" value="${c?.endDate || today}" required></div>
    <div class="field"><label>งบยิงแอดต่อวัน (บาท/วัน)</label><input name="dailyBudget" type="number" min="0.01" max="1000000000000" step="0.01" value="${c?.dailyBudget ?? ''}" placeholder="ไม่บังคับ เช่น 100"><small class="hint">หักจากเครดิตตามวันที่ผ่านไปครบแล้ว (เวลาไทย) เมื่อเปิดหักอัตโนมัติ</small></div>
    <div class="field"><label>การหักงบรายวัน</label><select name="autoDeduct"><option value="yes" ${c?.autoDeduct !== false ? 'selected' : ''}>หักอัตโนมัติตามงบต่อวัน</option><option value="no" ${c?.autoDeduct === false ? 'selected' : ''}>บันทึกค่าแอดเอง</option></select><small class="hint">ระบุงบต่อวันและเติมเครดิตก่อน หยุดหักเมื่อพักแคมเปญหรือเงินหมด</small></div>
    ${number('targetQty', 'เป้าขายรวมทุกสินค้าที่แนบ (ชิ้น)', c?.targetQty ?? '', 1, '1')}
    <div class="field"><label>แบ่งเก็บยิงแอดต่อ (บาท/ชิ้นที่ขาย)</label><input name="reservePerUnit" type="number" min="0" max="1000000000000" step="0.01" value="${c?.reservePerUnit ?? ''}" placeholder="เช่น 50"><small class="hint">ระบุ 0 เพื่อไม่แบ่งเก็บ หรือเว้นว่างเพื่อใช้เปอร์เซ็นต์กำไร ใช้เป็นค่าเริ่มต้นตอนขาย</small></div>
    ${number('reservePercent', 'แบ่งกำไรเก็บยิงแอดต่อ (%)', c?.reservePercent ?? 20, 0, '0.01', 100)}
    <div class="field"><label>ลิงก์โฆษณา / โพสต์</label><input name="url" type="url" maxlength="2000" value="${esc(c?.url || '')}" placeholder="https://..."></div>
    <div class="field ad-wide"><label>กลุ่มเป้าหมาย / ครีเอทีฟ / หมายเหตุ</label><textarea name="note" maxlength="2000" rows="2">${esc(c?.note || '')}</textarea></div>
    </div><p class="hint ad-plan-preview" aria-live="polite"></p>`;
}
export function renderAds({ products, transactions, adCampaigns, adWallet = [] }, { today, esc, fmt, metric }) {
  const metrics = adCampaigns.map(c => adMetrics(c, transactions, today));
  const wallet = adWalletMetrics(adWallet, transactions);
  const dailyRate = adCampaigns.filter(c=>c.status==='active' && c.autoDeduct!==false && c.startDate<=today && (campaignUntilBudget(c)||c.endDate>=today)).reduce((sum,c)=>sum+(c.dailyBudget||0),0);
  const total = key => metrics.reduce((sum, m) => sum + m[key], 0);
  return `<section class="stats ad-summary">${metric('เครดิต Ads Manager คงเหลือ', fmt(wallet.balance), 'เงินที่เติม − ค่าแอดที่หักเครดิต', 'wallet')}${metric('ค่าแอดรวม', fmt(total('spend')), 'รวมยอดจริงและยอดอัตโนมัติตามงบต่อวัน', 'down')}${metric('กำไรยอดขายที่ผูกหลังหักแอด', fmt(total('net')), 'ยอดขายที่ระบุแคมเปญเท่านั้น', 'wallet')}${metric('แนะนำเก็บยิงแอดต่อ', fmt(total('fixedReserve') + Math.min(total('percentReserve'), Math.max(0, total('cashNet')))), 'รวมยอดแบ่งต่อชิ้นและเปอร์เซ็นต์กำไรของแต่ละแคมเปญ', 'sparkles')}</section>
    <section class="panel ad-wallet"><div class="section-heading"><h2>เติมเงิน Ads Manager</h2><button id="ad-wallet-export" class="btn btn-ghost">ส่งออกประวัติเติมเงิน</button></div>
      <p class="hint">ค่าแอดอัตโนมัติเป็นยอดคำนวณจากงบที่ตั้ง ไม่ใช่ยอดจากแพลตฟอร์ม ระบบอัปเดตเมื่อเปิดเว็บหรือข้ามวันขณะเปิดเว็บ ใช้เครดิตร่วมกันทุกแคมเปญตามลำดับรหัสแคมเปญ หากเครดิตไม่พอจะหักได้เท่าที่เหลือ</p>
      <p class="hint">กระเป๋ากลางใช้ร่วมกันทุกแคมเปญ บันทึกยอดที่เติมจริงแต่ละครั้ง ไม่ใช่ยอดสะสม เติมจากส่วนนี้หรือจากแคมเปญด้านล่างเข้ากระเป๋ากลางเดียวกัน ทั้งสองแบบไม่ลงต้นทุนซ้ำ ค่าแอดอัตโนมัติและยอดใช้จริงจะหักเครดิตและลงต้นทุน โดยวันที่มีบันทึกยอดจริงจะใช้ยอดจริงแทน</p>
      <dl class="ad-metrics"><div><dt>เติมเงินสะสม</dt><dd data-wallet-total>${fmt(wallet.toppedUp)}</dd></div><div><dt>ค่าแอดที่หักจากกระเป๋า</dt><dd data-wallet-spent>${fmt(wallet.spent)}</dd></div><div><dt>เครดิตคงเหลือตามบันทึก</dt><dd data-wallet-balance>${fmt(wallet.balance)}</dd></div></dl>
      <p class="hint" data-wallet-duration>อัตราหักอัตโนมัติรวม ${fmt(dailyRate)}/วัน · ${dailyRate>0 ? `เครดิตพอประมาณ ${(Math.max(0,wallet.balance)/dailyRate).toLocaleString('th-TH',{maximumFractionDigits:1})} วัน หากทุกแคมเปญยังใช้อัตราเดิม` : 'ยังไม่มีแคมเปญที่หักอัตโนมัติรายวัน'}</p>
      ${wallet.balance < 0 ? '<p class="ad-warning" role="status">ค่าแอดที่บันทึกเกินยอดเติมเงิน ตรวจยอดเติมหรือแหล่งชำระของรายการค่าแอดให้ครบ</p>' : ''}
      <details class="ad-wallet-details"><summary>+ เติมเงินเพิ่ม / ประวัติ (${adWallet.length})</summary>
        <form id="ad-topup-form"><div class="form-grid ad-form-grid">${number('amount','จำนวนเงินที่เติมเพิ่ม (บาท)','',.01)}<div class="field"><label>วันที่เติมเงิน</label><input name="date" type="date" value="${today}" max="${today}" required></div><div class="field ad-wide"><label>หมายเหตุ / เลขอ้างอิงการเติมเงิน</label><input name="note" maxlength="500"></div></div><button class="btn btn-primary" type="submit">บันทึกเติมเงิน</button></form>
        <ul class="ad-ledger">${[...adWallet].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>`<li><span>${e.date} · ${fmt(e.amount)}<small>${esc(e.note || 'เติมเงิน Ads Manager')}${e.campaignId ? ' · แคมเปญ '+esc(adCampaigns.find(c=>c.id===e.campaignId)?.name || '') : ' · เครดิตกลาง'}</small></span><button class="btn btn-ghost" data-ad-remove-topup="${esc(e.id)}">ลบรายการผิด</button></li>`).join('') || '<li>ยังไม่มีประวัติเติมเงิน</li>'}</ul>
      </details><p class="hint">ยอดนี้คำนวณจากข้อมูลที่บันทึกในร้าน ไม่ได้ดึงยอดจาก Ads Manager ค่าแอดเก่าหรือรายการที่เลือกจ่ายตรงไม่หักจากกระเป๋านี้</p>
    </section>
    <div class="panel"><h2>วางแผนและติดตามการยิงแอด</h2><p class="hint">บันทึกแคมเปญที่คุณยิงผ่านแพลตฟอร์มโฆษณา ผูกสินค้าและยอดขายเพื่อติดตามผล เมนูนี้ไม่ส่งโฆษณาออกไปหรือดึงยอดใช้จ่ายอัตโนมัติ</p>
    <p class="hint">ค่าแอดหักจากเครดิต Ads Manager ที่เติมไว้ ตั้งอัตราต่อวันเพื่อหักอัตโนมัติ หรือบันทึกค่าแอดจริงด้านล่าง ระบบลงรายจ่ายครั้งเดียวและหักจากกำไรสินค้า โดยเก็บต้นทุนซื้อสินค้าเดิมไว้ สัดส่วน 20% เป็นค่าเริ่มต้นให้ปรับตามเงินหมุนเวียนของร้าน</p>
    <datalist id="ad-channels"><option value="Facebook / Instagram"><option value="TikTok"><option value="Google"><option value="LINE"><option value="Shopee"><option value="Lazada"></datalist>
    <details id="ad-create" ${adCampaigns.length ? '' : 'open'}><summary>+ เพิ่มแคมเปญยิงแอด</summary><form id="ad-create-form">${campaignFields(null,products,today,esc)}<button class="btn btn-primary" type="submit" ${products.length ? '' : 'disabled'}>สร้างแคมเปญ</button>${products.length ? '' : '<p class="hint">เพิ่มสินค้าในสต็อกก่อน เพื่อผูกแคมเปญกับสินค้า</p>'}</form></details></div>
    <div class="panel"><div class="section-heading"><h2>แคมเปญของร้าน</h2><button id="ad-export" class="btn btn-ghost">ส่งออก CSV</button></div><div class="task-filters"><div class="field"><label>ค้นหาแคมเปญ / สินค้า</label><input id="ad-search" type="search" value="${esc(searchText)}"></div><div class="field"><label>สถานะแคมเปญ</label><select id="ad-filter"><option value="all">ทุกสถานะ</option>${Object.entries(phaseLabels).map(([key,label])=>`<option value="${key}" ${statusFilter===key?'selected':''}>${label}</option>`).join('')}</select></div></div><p class="hint" id="ad-count" role="status"></p>
    <div class="ad-list">${adCampaigns.map((c, index) => {
      const m = metrics[index], attached = products.filter(p => campaignHasProduct(c,p.id)), phase = campaignPhase(c,today,transactions,adWallet);
      const enabled = c.status === 'active' && c.autoDeduct !== false;
      const expanded = expandedCampaigns.has(c.id);
      const eligible = transactions.filter(tx=>attached.some(p => saleMatchesProduct(tx,p)) && !tx.adCampaignId);
      const stat = (label,value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
      return `<article class="ad-card" data-ad-id="${esc(c.id)}" data-ad-phase="${phase}" data-ad-search="${esc([c.name,...attached.map(p => p.name),c.channel,c.note].join(' ').toLowerCase())}">
        <header class="ad-card-header"><div><span class="tag preorder">${phaseLabels[phase]}</span><h3>${esc(c.name)}</h3><p>${esc(attached.map(p => p.name).join(', ') || 'ไม่พบสินค้า')} · ${esc(c.channel)}</p><p class="hint">${campaignUntilBudget(c) ? `เริ่ม ${c.startDate} · ยิงต่อเนื่องจนเครดิตหมด · ไม่กำหนดวันสิ้นสุด` : `${c.startDate} ถึง ${c.endDate} · ${m.days} วัน`}</p></div><div class="ad-card-controls"><button type="button" class="ad-toggle" role="switch" aria-checked="${enabled}" aria-label="หักเงินอัตโนมัติ ${esc(c.name)}" data-ad-toggle><span class="ad-toggle-track" aria-hidden="true"></span><span>${enabled ? 'ON' : 'OFF'}</span></button><button type="button" class="btn btn-ghost ad-expand" data-ad-expand aria-expanded="${expanded}" aria-controls="ad-body-${index}" aria-label="ย่อหรือขยายรายละเอียด ${esc(c.name)}"><span data-ad-arrow aria-hidden="true">${expanded ? '▴' : '▾'}</span> รายละเอียด</button></div></header>
        <p class="hint ad-deduction-status">${enabled ? `ON · หักอัตโนมัติ ${c.dailyBudget > 0 ? fmt(c.dailyBudget)+'/วัน เมื่ออยู่ในช่วงแคมเปญและมีเครดิต' : 'เมื่อระบุงบต่อวันและมีเครดิต'}` : 'OFF · ไม่หักเงินอัตโนมัติ'} · มีผลตั้งแต่วันนี้ คำนวณเมื่อครบวัน</p>
        <div class="ad-card-body" id="ad-body-${index}" ${expanded ? '' : 'hidden'}><div class="ad-card-actions">${attached.map(p => `<button class="btn btn-ghost" data-ad-product="${esc(p.id)}">ดูสินค้า${attached.length > 1 ? `: ${esc(p.name)}` : ''}</button>`).join('')}${safeAdUrl(c.url) ? `<a class="btn btn-ghost" href="${esc(safeAdUrl(c.url))}" target="_blank" rel="noopener noreferrer">เปิดโฆษณา ↗</a>` : ''}</div>
        <details class="ad-campaign-topup"><summary>+ เติมเครดิตจากแคมเปญนี้ / ประวัติ (${adWallet.filter(e=>e.campaignId===c.id).length})</summary><p class="hint">ใส่ยอดที่เพิ่งเติมใน Ads Manager สำหรับแคมเปญนี้ ระบบบันทึกเครดิตกลางครั้งเดียวและระบุว่าเติมจากแคมเปญนี้ ไม่ต้องกรอกยอดเดียวกันซ้ำในส่วนเติมเงินด้านบน เติมย้อนหลังจะคำนวณค่าแอดใหม่ตั้งแต่วันที่มีเครดิตจนถึงเมื่อวาน ตามงบต่อวันและสถานะแคมเปญ</p><form class="ad-campaign-topup-form"><div class="form-grid ad-form-grid">${number('amount','จำนวนเงินที่เติมเพิ่ม (บาท)','',.01)}<div class="field"><label>วันที่เติมเงิน</label><input name="date" type="date" value="${today}" max="${today}" required></div><div class="field ad-wide"><label>หมายเหตุ / เลขอ้างอิง</label><input name="note" maxlength="500"></div></div><p class="hint ad-topup-preview" aria-live="polite"></p><button class="btn btn-primary" type="submit">เติมเครดิต Ads Manager</button></form><p>ยอดเติมผ่านแคมเปญนี้ ${fmt(adWallet.filter(e=>e.campaignId===c.id).reduce((sum,e)=>sum+e.amount,0))}</p><ul class="ad-ledger">${adWallet.filter(e=>e.campaignId===c.id).map(e=>`<li><span>${e.date} · ${fmt(e.amount)}<small>${esc(e.note)}</small></span><button class="btn btn-ghost" data-ad-remove-topup="${esc(e.id)}">ลบรายการผิด</button></li>`).join('') || '<li>ยังไม่มีประวัติเติมเข้าแคมเปญ</li>'}</ul></details>
        ${c.note ? `<p class="ad-note">${esc(c.note)}</p>` : ''}
        <dl class="ad-metrics">${stat('งบที่ตั้งต่อวัน',c.dailyBudget == null ? 'ยังไม่ระบุ' : fmt(c.dailyBudget)+'/วัน')}${stat('ค่าแอดรวม',fmt(m.spend))}${stat('ค่าแอดใช้จริงวันนี้',fmt(m.spentToday))}${stat('เป้าขาย / ขายที่ผูก',`${c.targetQty} / ${m.qty} ชิ้น`)}${stat('ค่าแอด / ชิ้นที่ขาย',m.actualPerUnit==null?'ยังไม่มียอดขาย':fmt(m.actualPerUnit))}${stat('ยอดขายที่ผูก',fmt(m.revenue))}${stat('กำไรก่อนหักแอด',fmt(m.grossProfit))}${stat('กำไรหลังหักแอด',fmt(m.net))}${stat('ยอดขาย ÷ ค่าแอด (ROAS)',m.roas==null?'—':m.roas.toFixed(2)+' เท่า')}</dl>
        ${phase==='exhausted'?'<p class="ad-warning">เครดิต Ads Manager หมดแล้ว เติมเงินเพิ่มเพื่อหักค่าแอดต่อ หรือตรวจและหยุดแอดที่แพลตฟอร์ม ระบบนี้ไม่ได้สั่งหยุดโฆษณาให้อัตโนมัติ</p>':''}${phase==='ended'?'<p class="ad-warning">ครบกำหนดแล้ว ตรวจยอดใช้จ่ายและเปลี่ยนสถานะเป็นจบแคมเปญเมื่อพร้อม</p>':''}
        <div class="ad-reserve"><strong>แนะนำแบ่งเก็บยิงแอดต่อ ${fmt(m.reserve)}</strong><p>${c.reservePerUnit != null ? `ตั้งไว้ ${fmt(c.reservePerUnit)}/ชิ้น · ยอดเดิมใช้อัตราที่บันทึกตอนขาย` : `แบ่งกำไร ${c.reservePercent}% หรือใช้อัตราต่อชิ้นที่ระบุตอนขาย`} · ขาย ${m.qty} ชิ้น · เฉลี่ย ${fmt(m.reservePerUnit)}/ชิ้น</p><p class="hint">ยอดแนะนำสะสม ยังไม่ได้หักเงินจริงหรือเติมเครดิต ค่าแบ่งต่อชิ้นคำนวณตามจำนวนขาย รวมยอดผ่อนที่ยังรับเงินไม่ครบ และอาจเกินกำไรตามเงินรับหลังแอด ${fmt(m.cashNet)} ส่วนเปอร์เซ็นต์คำนวณจากกำไรที่เป็นบวก</p></div>
        <details><summary>ต้นทุนโฆษณาที่แบ่งให้สินค้า</summary><p class="hint">ค่าแอดแบ่งเท่ากันตามสินค้าที่แนบ ณ วันที่บันทึกค่าใช้จ่าย</p><ul class="ad-ledger">${attached.map(p => {const share = m.expenses.reduce((sum,tx) => sum + (adSpendAllocations(tx,c).find(a => a.productId === p.id)?.amount || 0),0); return `<li><span>${esc(p.name)}</span><strong>ค่าแอดแคมเปญนี้ ${fmt(share)}</strong></li>`;}).join('')}</ul></details>
        <section class="ad-daily-section"><div class="section-heading"><h4>ค่าใช้จ่ายรายวันของแคมเปญ</h4><button class="btn btn-ghost" data-ad-daily-export>ส่งออกค่าแอดรายวัน</button></div><div class="ad-table-scroll"><table class="ad-daily-table"><thead><tr><th>วันที่</th><th>รวมจริง / อัตโนมัติ</th><th>ใช้เครดิต</th><th>จ่ายตรง</th></tr></thead><tbody>${dailyAdSpend(c.id,transactions).map(day=>`<tr data-ad-day="${day.date}"><td>${day.date}</td><td>${fmt(day.amount)}</td><td>${fmt(day.wallet)}</td><td>${fmt(day.direct)}</td></tr>`).join('') || '<tr><td colspan="4">ยังไม่มีค่าแอดรายวัน</td></tr>'}</tbody></table></div><p class="hint">หักอัตโนมัติเฉพาะวันที่ผ่านไปครบแล้ว วันใดบันทึกยอดจริงจะใช้ยอดจริงแทนทั้งวัน ไม่บวกซ้ำกับยอดอัตโนมัติ</p></section><details class="ad-spend-details"><summary>+ บันทึกค่าแอดรายวัน / ประวัติ (${m.expenses.length})</summary><form class="ad-spend-form"><div class="form-grid ad-form-grid">${number('amount','ค่าแอดที่ใช้เพิ่มในวันที่เลือก (บาท)','',.01)}<div class="field"><label>แหล่งชำระค่าแอด</label><select name="paymentSource"><option value="direct" >จ่ายตรง / ไม่หักกระเป๋า</option><option value="wallet" selected>หักเครดิต Ads Manager ที่เติมไว้</option></select></div><div class="field"><label>วันที่ใช้แอด / ลงบัญชี</label><input name="date" type="date" value="${today}" max="${today}" required></div><div class="field ad-wide"><label>หมายเหตุ / เลขใบเสร็จ</label><input name="note" maxlength="500"></div></div><p class="hint">วันที่มีค่าแอดอัตโนมัติ ให้กรอกยอดใช้จริงของวันนั้นเพื่อแทนยอดอัตโนมัติ หลังจากนั้นกรอกเฉพาะยอดใช้เพิ่มที่ยังไม่ได้บันทึก ไม่ต้องบันทึกยอดเติมเงินซ้ำที่นี่ ค่าแอดหักกำไรในวันที่จ่ายจริง แม้จ่ายนอกช่วงแคมเปญ</p><p class="hint ad-day-preview" aria-live="polite"></p><button class="btn btn-primary" type="submit">บันทึกค่าแอดรายวัน</button></form><ul class="ad-ledger">${m.expenses.map(tx=>`<li><span>${tx.date} · ${fmt(tx.amount)}<small>${esc(tx.desc)} · ${tx.adWalletFunded ? 'หักเครดิต Ads Manager' : 'จ่ายตรง'}</small></span>${tx.adAutomatic ? '<span class="tag">อัตโนมัติ / ประมาณการ</span>' : ''}<button class="btn btn-ghost" data-ad-remove-spend="${esc(tx.id)}">ลบรายการผิด</button></li>`).join('') || '<li>ยังไม่มีค่าใช้จ่าย</li>'}</ul></details>
        <details class="ad-sales-details"><summary>ผูกยอดขาย / ผลลัพธ์ (${m.sales.length})</summary><p class="hint">เลือกแคมเปญตอนขาย หรือผูกยอดขายย้อนหลังที่นี่ แต่ละยอดขายผูกได้หนึ่งแคมเปญเท่านั้น ยอดขายระหว่างวันเริ่ม–สิ้นสุดไม่ได้ถือว่ามาจากแอดโดยอัตโนมัติ</p><form class="ad-link-form"><div class="field"><label>ยอดขายของสินค้าที่แนบและยังไม่ผูกแคมเปญ</label><select name="transactionId" required><option value="">เลือกยอดขาย</option>${eligible.map(tx=>`<option value="${esc(tx.id)}">${tx.date} · ${esc(tx.desc)} · ${fmt(tx.amount)}</option>`).join('')}</select></div><button class="btn btn-primary" type="submit">ผูกยอดขาย</button></form><ul class="ad-ledger">${m.sales.map(tx=>`<li><span>${tx.date} · ${fmt(tx.amount)} · ${tx.qty} ชิ้น<small>${esc(tx.desc)}${tx.type==='installment'?' · ผ่อนชำระ':''}${tx.adReservePerUnit != null ? ' · แบ่งยิงแอด '+fmt(tx.adReservePerUnit * tx.qty)+' ('+fmt(tx.adReservePerUnit)+'/ชิ้น)' : ''}</small></span><button class="btn btn-ghost" data-ad-unlink="${esc(tx.id)}">ยกเลิกการผูก</button></li>`).join('') || '<li>ยังไม่มียอดขายที่ผูก</li>'}</ul></details>
        <details class="ad-edit-details"><summary>แก้ไขแคมเปญ / สถานะ</summary><form class="ad-edit-form">${campaignFields(c,products,today,esc)}<button class="btn btn-primary" type="submit">บันทึกแคมเปญ</button></form><button class="btn btn-ghost danger-text" data-ad-delete>ลบแคมเปญที่ไม่มีประวัติ</button></details>
        </div>
      </article>`;
    }).join('')}</div><div id="ad-empty" class="empty" hidden>ไม่มีแคมเปญที่ตรงกับตัวกรอง</div></div>`;
}
export function wireAds(state, { today, fmt, commit, confirm, alert, csv, openProduct }) {
  const create = document.getElementById('ad-create-form');
  if (!create) return;
  const values = form => {
    const data = new FormData(form), raw = Object.fromEntries(data);
    delete raw.extraProductId;
    const result = Object.fromEntries(Object.entries(raw).map(([k,v]) => [k,['targetQty','reservePercent'].includes(k) ? Number(v) : v.trim()]));
    result.reservePerUnit = raw.reservePerUnit.trim() === '' ? null : Number(raw.reservePerUnit);
    result.autoDeduct = raw.autoDeduct === 'yes';
    result.dailyBudget = raw.dailyBudget.trim() === '' ? null : Number(raw.dailyBudget);
    result.productIds = [...new Set([result.productId, ...data.getAll('extraProductId')].filter(Boolean))];
    if (result.runMode === 'until_budget') result.endDate = '';
    return result;
  };
  const run = async (action, question) => {
    try { if (question && !await confirm(question)) return; await commit(action); } catch(error) { if (!error.storageReported) alert(error.message); }
  };
  const expectedWallet = JSON.stringify(state.adWallet || []);
  document.getElementById('ad-topup-form').onsubmit = e => {
    e.preventDefault(); const data = new FormData(e.currentTarget);
    run({type:'topup', expectedWallet, amount:Number(data.get('amount')), date:data.get('date'), note:data.get('note').trim()});
  };
  document.querySelectorAll('[data-ad-remove-topup]').forEach(button => button.onclick = () => run({type:'removeTopup', expectedWallet, entryId:button.dataset.adRemoveTopup, expected:JSON.stringify(state.adCampaigns.find(c=>c.id===(state.adWallet || []).find(e=>e.id===button.dataset.adRemoveTopup)?.campaignId))}, 'ลบบันทึกเติมเงินที่ผิด? เครดิตคงเหลือจะคำนวณใหม่ ไม่กระทบยอดใช้จริงที่บันทึกไว้ การลบนี้ไม่ได้คืนเงินจริงจาก Ads Manager'));
  document.getElementById('ad-wallet-export').onclick = () => csv('ads-topups', [['วันที่','ยอดเติม (บาท)','หมายเหตุ','แคมเปญที่เติม'],...(state.adWallet || []).map(e=>[e.date,e.amount,e.note,state.adCampaigns.find(c=>c.id===e.campaignId)?.name || 'เครดิตกลาง'])]);
  const preview = form => {
    const untilBudget = form.elements.namedItem('runMode').value === 'until_budget';
    form.querySelector('.ad-end-field').hidden = untilBudget;
    const end = form.elements.namedItem('endDate'); end.disabled = untilBudget; end.required = !untilBudget;
    form.querySelectorAll('[name="extraProductId"]').forEach(input => {
      input.disabled = input.value === form.elements.namedItem('productId').value;
      if (input.disabled) input.checked = false;
    });
    const v=values(form);
    form.querySelector('.ad-plan-preview').textContent = `แบ่งเก็บ ${v.reservePerUnit != null ? fmt(v.reservePerUnit)+"/ชิ้นที่ขาย" : v.reservePercent+"% ของกำไรตามเงินรับจริงหลังหักแอด"} · ใช้เงินที่เติมใน Ads Manager ร่วมกับทุกแคมเปญ${v.dailyBudget>0 ? ' · หักอัตโนมัติวันละ '+fmt(v.dailyBudget) : ''}`;
  };
  document.querySelectorAll('#ad-create-form, .ad-edit-form').forEach(form=> {form.addEventListener('input',()=>preview(form)); form.addEventListener('change',()=>preview(form)); preview(form);});
  create.onsubmit = e => { e.preventDefault(); run({type:'create',values:values(create)}); };
  document.querySelectorAll('[data-ad-id]').forEach(card=>{
    const c=state.adCampaigns.find(c=>c.id===card.dataset.adId), expected=JSON.stringify(c);
    const action = (type, extra={})=>({type,campaignId:c.id,expected,...extra});
    const expand = card.querySelector('[data-ad-expand]');
    expand.onclick = () => {
      const open = expand.getAttribute('aria-expanded') !== 'true';
      if (open) expandedCampaigns.add(c.id); else expandedCampaigns.delete(c.id);
      expand.setAttribute('aria-expanded', String(open));
      expand.querySelector('[data-ad-arrow]').textContent = open ? '▴' : '▾';
      card.querySelector('.ad-card-body').hidden = !open;
    };
    const toggle = card.querySelector('[data-ad-toggle]');
    toggle.onclick = async () => {
      toggle.disabled = true;
      try { await run(action('toggle', {enabled:toggle.getAttribute('aria-checked') !== 'true'})); }
      finally { toggle.disabled = false; }
    };
    const topupForm=card.querySelector('.ad-campaign-topup-form');
    const previewTopup=()=>{
      const amount=Number(topupForm.elements.namedItem('amount').value), date=topupForm.elements.namedItem('date').value;
      let text=`เติมเครดิตเพิ่ม ${fmt(Number.isFinite(amount)&&amount>0?amount:0)}`;
      if (Number.isFinite(amount) && amount>0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && date<=today) {
        try {
          const next=reconcileAutomaticAds({...state,adWallet:[...(state.adWallet||[]),{id:'preview',amount,date,note:'',campaignId:c.id}]},today);
          text+=` · เครดิตกลางหลังหัก ${fmt(adWalletMetrics(next.adWallet,next.transactions).balance)}`;
        } catch { text+=' · กรุณาตรวจวันที่เติมเงิน'; }
      }
      topupForm.querySelector('.ad-topup-preview').textContent=text;
    };
    topupForm.addEventListener('input',previewTopup);previewTopup();
    topupForm.onsubmit=e=>{e.preventDefault();const data=new FormData(topupForm);run(action('topup',{expectedWallet,amount:Number(data.get('amount')),date:data.get('date'),note:data.get('note').trim()}));};
    card.querySelector('.ad-edit-form').onsubmit = e=>{e.preventDefault();run(action('edit',{values:values(e.currentTarget)}));};
    card.querySelector('.ad-spend-form').onsubmit = e=>{e.preventDefault();const data=new FormData(e.currentTarget);run(action('spend',{amount:Number(data.get('amount')),date:data.get('date'),note:data.get('note').trim(),adWalletFunded:data.get('paymentSource')==='wallet'}));};
    const spendForm = card.querySelector('.ad-spend-form');
    const previewDay = () => {
      const date = spendForm.elements.namedItem('date').value;
      const existing = dailyAdSpend(c.id,state.transactions.filter(tx=>!tx.adAutomatic)).find(d=>d.date===date)?.amount || 0;
      const amount = Number(spendForm.elements.namedItem('amount').value);
      spendForm.querySelector('.ad-day-preview').textContent = `วันที่เลือกบันทึกแล้ว ${fmt(existing)} · รวมหลังบันทึก ${fmt(existing + (Number.isFinite(amount) && amount>0 ? amount : 0))} · ยอดจริงแทนยอดอัตโนมัติของวันนี้ กรอกเฉพาะยอดจริงที่ยังไม่ได้บันทึก`;
    };
    spendForm.addEventListener('input',previewDay); spendForm.addEventListener('change',previewDay); previewDay();
    card.querySelector('[data-ad-daily-export]').onclick = () => csv('ads-daily', [['แคมเปญ','วันที่','ค่าแอดรวม','ใช้เครดิต','จ่ายตรง'],...dailyAdSpend(c.id,state.transactions).map(d=>[c.name,d.date,d.amount,d.wallet,d.direct])]);
    card.querySelector('.ad-link-form').onsubmit = e=>{e.preventDefault();const transactionId=new FormData(e.currentTarget).get('transactionId');run(action('link',{transactionId,expectedTransaction:JSON.stringify(state.transactions.find(tx=>tx.id===transactionId))}));};
    [['[data-ad-remove-spend]','adRemoveSpend','removeSpend','ลบค่าแอดที่บันทึกผิด? ระบบจะคืนเครดิตเฉพาะยอดที่เคยหักจากกระเป๋า คำนวณกำไรใหม่ และไม่หักอัตโนมัติซ้ำในวันที่ของรายการนี้'],['[data-ad-unlink]','adUnlink','unlink','ยกเลิกการผูกยอดขายกับแคมเปญนี้? ยอดขายและสต็อกยังคงเดิม']].forEach(([selector,key,type,question])=>card.querySelectorAll(selector).forEach(button=>button.onclick=()=>{const transactionId=button.dataset[key];run(action(type,{transactionId,expectedTransaction:JSON.stringify(state.transactions.find(tx=>tx.id===transactionId))}),question);}));
    card.querySelector('[data-ad-delete]').onclick=()=>run(action('delete'),'ลบแคมเปญนี้? ทำได้เฉพาะแคมเปญที่ยังไม่มีประวัติค่าใช้จ่ายหรือยอดขาย');
    card.querySelectorAll('[data-ad-product]').forEach(button => button.onclick=()=>openProduct(button.dataset.adProduct));
  });
  const apply = ()=>{
    searchText=document.getElementById('ad-search').value;statusFilter=document.getElementById('ad-filter').value;
    let count=0;document.querySelectorAll('[data-ad-id]').forEach(card=>{card.hidden=!(card.dataset.adSearch.includes(searchText.trim().toLowerCase())&&(statusFilter==='all'||card.dataset.adPhase===statusFilter));if(!card.hidden)count++;});
    document.getElementById('ad-count').textContent=`แสดง ${count} จาก ${state.adCampaigns.length} แคมเปญ · ตัวเลขสรุปด้านบนรวมทุกแคมเปญ`;
    document.getElementById('ad-empty').hidden=count>0;
  };
  document.getElementById('ad-search').oninput=document.getElementById('ad-filter').onchange=apply;apply();
  document.getElementById('ad-export').onclick=()=>{
    const ids=new Set([...document.querySelectorAll('[data-ad-id]:not([hidden])')].map(card=>card.dataset.adId));
    csv('ads', [['แคมเปญ','สินค้า','ช่องทาง','สถานะ','เริ่ม','สิ้นสุด','งบต่อวัน','เป้าจำนวน','ค่าแอดรวมจริงและอัตโนมัติ','ยอดขายที่ผูก','จำนวนขาย','กำไรก่อนแอด','กำไรหลังแอด','กำไรตามเงินรับหลังแอด','เก็บต่อ %','เก็บต่อบาท/ชิ้น','แนะนำเก็บสะสม','ROAS'],...state.adCampaigns.filter(c=>ids.has(c.id)).map(c=>{const m=adMetrics(c,state.transactions,today);return[c.name,state.products.filter(p=>campaignHasProduct(c,p.id)).map(p=>p.name).join(' / '),c.channel,phaseLabels[campaignPhase(c,today,state.transactions,state.adWallet)],c.startDate,campaignUntilBudget(c)?'จนเครดิตหมด':c.endDate,c.dailyBudget??'',c.targetQty,m.spend,m.revenue,m.qty,m.grossProfit,m.net,m.cashNet,c.reservePercent,c.reservePerUnit??'',m.reserve,m.roas??''];})]);
  };
}
