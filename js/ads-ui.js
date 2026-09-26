import { measurementLabel } from "./inventory-tools.js";
import { dailyAdSpend, adWalletMetrics, campaignProductIds, campaignHasProduct, campaignUntilBudget, adSpendAllocations, adStatuses, adMetrics, campaignPhase, safeAdUrl, saleMatchesProduct, productAdMetrics } from './ads.js';
const phaseLabels = { ...adStatuses, scheduled: 'ยังไม่ถึงวันเริ่ม', ended: 'ครบกำหนดแล้ว', exhausted: 'งบหมดแล้ว' };
let searchText = '', statusFilter = 'all';
const number = (name, label, value, min = 0, step = '0.01', max = '') => `<div class="field"><label>${label}</label><input name="${name}" type="number" min="${min}" step="${step}" ${max ? `max="${max}"` : ''} value="${value}" required></div>`;
function campaignFields(c, products, today, esc) {
  return `<div class="form-grid ad-form-grid">
    <div class="field"><label>ชื่อแคมเปญ</label><input name="name" maxlength="120" value="${esc(c?.name || '')}" placeholder="เช่น เสื้อรุ่นใหม่ รอบเดือนนี้" required></div>
    <div class="field"><label>สินค้าแรก (รวมทุกสี/ไซส์)</label><select name="productId" required><option value="">เลือกสินค้า</option>${products.map(p => `<option value="${esc(p.id)}" ${c?.productId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <fieldset class="ad-product-picker ad-wide"><legend>แนบสินค้าเพิ่มเติมในแคมเปญเดียวกัน</legend><div class="ad-product-options">${products.map(p => `<label><input type="checkbox" name="extraProductId" value="${esc(p.id)}" ${campaignProductIds(c).slice(1).includes(p.id) ? 'checked' : ''}><span>${esc(p.name)}</span></label>`).join('')}</div><p class="hint">ค่าแอดแต่ละครั้งแบ่งเท่ากันระหว่างสินค้าที่แนบ เศษสตางค์จัดให้ยอดรวมตรงกับที่จ่าย การเพิ่มสินค้าใหม่ไม่เปลี่ยนส่วนแบ่งค่าแอดเก่า</p></fieldset>
    <div class="field"><label>ช่องทางโฆษณา</label><input name="channel" list="ad-channels" maxlength="80" value="${esc(c?.channel || 'Facebook / Instagram')}" required></div>
    <div class="field"><label>สถานะ</label><select name="status">${Object.entries(adStatuses).map(([key, label]) => `<option value="${key}" ${(c?.status || 'active') === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div class="field"><label>ระยะเวลายิงแอด</label><select name="runMode"><option value="until_budget" ${!c || campaignUntilBudget(c) ? 'selected' : ''}>ยิงต่อเนื่องจนงบหมด (ไม่กำหนดวันหยุด)</option><option value="dated" ${c && !campaignUntilBudget(c) ? 'selected' : ''}>กำหนดวันสิ้นสุด</option></select></div>
    <div class="field"><label>วันเริ่มยิงแอด</label><input name="startDate" type="date" value="${c?.startDate || today}" required></div>
    <div class="field ad-end-field"><label>วันสิ้นสุด (รวมวันนี้)</label><input name="endDate" type="date" value="${c?.endDate || today}" required></div>
    ${number('budget', 'งบแอดทั้งแคมเปญ (บาท)', c?.budget ?? '', 0)}
    <div class="field"><label>งบยิงแอดต่อวัน (บาท/วัน)</label><input name="dailyBudget" type="number" min="0.01" max="1000000000000" step="0.01" value="${c?.dailyBudget ?? ''}" placeholder="ไม่บังคับ เช่น 100"><small class="hint">ใช้ประมาณระยะเวลาที่งบจะพอ ไม่ลงค่าใช้จ่ายอัตโนมัติ</small></div>
    ${number('targetQty', 'เป้าขายรวมทุกสินค้าที่แนบ (ชิ้น)', c?.targetQty ?? '', 1, '1')}
    ${number('reservePercent', 'แบ่งกำไรเก็บยิงแอดต่อ (%)', c?.reservePercent ?? 20, 0, '0.01', 100)}
    <div class="field"><label>ลิงก์โฆษณา / โพสต์</label><input name="url" type="url" maxlength="2000" value="${esc(c?.url || '')}" placeholder="https://..."></div>
    <div class="field ad-wide"><label>กลุ่มเป้าหมาย / ครีเอทีฟ / หมายเหตุ</label><textarea name="note" maxlength="2000" rows="2">${esc(c?.note || '')}</textarea></div>
    </div><p class="hint ad-plan-preview" aria-live="polite"></p>`;
}
export function renderAds({ products, transactions, adCampaigns, adWallet = [] }, { today, esc, fmt, metric }) {
  const metrics = adCampaigns.map(c => adMetrics(c, transactions, today));
  const wallet = adWalletMetrics(adWallet, transactions);
  const total = key => metrics.reduce((sum, m) => sum + m[key], 0);
  return `<section class="stats ad-summary">${metric('งบที่วางแผนทั้งหมด', fmt(adCampaigns.reduce((sum,c) => sum + c.budget,0)), `${adCampaigns.length} แคมเปญ · รวมทุกสถานะ`, 'chart')}${metric('ค่าแอดจ่ายจริง', fmt(total('spend')), 'บันทึกเป็นรายจ่ายและต้นทุนโฆษณาสินค้า', 'down')}${metric('กำไรยอดขายที่ผูกหลังหักแอด', fmt(total('net')), 'ยอดขายที่ระบุแคมเปญเท่านั้น', 'wallet')}${metric('แนะนำเก็บยิงแอดต่อ', fmt(Math.min(total('reserve'), Math.max(0, total('cashNet')))), 'รวมตามสัดส่วน แต่ไม่เกินกำไรรวมตามเงินรับหลังแอด', 'sparkles')}</section>
    <section class="panel ad-wallet"><div class="section-heading"><h2>เติมเงิน Ads Manager</h2><button id="ad-wallet-export" class="btn btn-ghost">ส่งออกประวัติเติมเงิน</button></div>
      <p class="hint">กระเป๋ากลางใช้ร่วมกันทุกแคมเปญ บันทึกยอดที่เติมจริงแต่ละครั้ง ไม่ใช่ยอดสะสม เติมจากส่วนนี้เป็นเครดิตกลาง หากต้องการเพิ่มงบแคมเปญด้วย ให้ใช้ปุ่มเติมเงินในแคมเปญด้านล่าง ทั้งสองแบบไม่ลงต้นทุนซ้ำ รายจ่ายในบัญชียังคงลงเมื่อบันทึกค่าแอดที่ใช้จริง</p>
      <dl class="ad-metrics"><div><dt>เติมเงินสะสม</dt><dd data-wallet-total>${fmt(wallet.toppedUp)}</dd></div><div><dt>ค่าแอดที่หักจากกระเป๋า</dt><dd data-wallet-spent>${fmt(wallet.spent)}</dd></div><div><dt>เครดิตคงเหลือตามบันทึก</dt><dd data-wallet-balance>${fmt(wallet.balance)}</dd></div></dl>
      ${wallet.balance < 0 ? '<p class="ad-warning" role="status">ค่าแอดที่บันทึกเกินยอดเติมเงิน ตรวจยอดเติมหรือแหล่งชำระของรายการค่าแอดให้ครบ</p>' : ''}
      <details class="ad-wallet-details"><summary>+ เติมเงินเพิ่ม / ประวัติ (${adWallet.length})</summary>
        <form id="ad-topup-form"><div class="form-grid ad-form-grid">${number('amount','จำนวนเงินที่เติมเพิ่ม (บาท)','',.01)}<div class="field"><label>วันที่เติมเงิน</label><input name="date" type="date" value="${today}" max="${today}" required></div><div class="field ad-wide"><label>หมายเหตุ / เลขอ้างอิงการเติมเงิน</label><input name="note" maxlength="500"></div></div><button class="btn btn-primary" type="submit">บันทึกเติมเงิน</button></form>
        <ul class="ad-ledger">${[...adWallet].sort((a,b)=>b.date.localeCompare(a.date)).map(e=>`<li><span>${e.date} · ${fmt(e.amount)}<small>${esc(e.note || 'เติมเงิน Ads Manager')}${e.campaignId ? ' · แคมเปญ '+esc(adCampaigns.find(c=>c.id===e.campaignId)?.name || '') : ' · เครดิตกลาง'}</small></span><button class="btn btn-ghost" data-ad-remove-topup="${esc(e.id)}">ลบรายการผิด</button></li>`).join('') || '<li>ยังไม่มีประวัติเติมเงิน</li>'}</ul>
      </details><p class="hint">ยอดนี้คำนวณจากข้อมูลที่บันทึกในร้าน ไม่ได้ดึงยอดจาก Ads Manager ค่าแอดเก่าหรือรายการที่เลือกจ่ายตรงไม่หักจากกระเป๋านี้</p>
    </section>
    <div class="panel"><h2>วางแผนและติดตามการยิงแอด</h2><p class="hint">บันทึกแคมเปญที่คุณยิงผ่านแพลตฟอร์มโฆษณา ผูกสินค้าและยอดขายเพื่อติดตามผล เมนูนี้ไม่ส่งโฆษณาออกไปหรือดึงยอดใช้จ่ายอัตโนมัติ</p>
    <p class="hint">งบที่ตั้งไว้ใช้วางแผนต้นทุนต่อชิ้น เมื่อจ่ายจริงให้บันทึกค่าแอดด้านล่าง ระบบลงรายจ่ายครั้งเดียวและหักจากกำไรสินค้า โดยเก็บต้นทุนซื้อสินค้าเดิมไว้ สัดส่วน 20% เป็นค่าเริ่มต้นให้ปรับตามเงินหมุนเวียนของร้าน</p>
    <datalist id="ad-channels"><option value="Facebook / Instagram"><option value="TikTok"><option value="Google"><option value="LINE"><option value="Shopee"><option value="Lazada"></datalist>
    <details id="ad-create" ${adCampaigns.length ? '' : 'open'}><summary>+ เพิ่มแคมเปญยิงแอด</summary><form id="ad-create-form">${campaignFields(null,products,today,esc)}<button class="btn btn-primary" type="submit" ${products.length ? '' : 'disabled'}>สร้างแคมเปญ</button>${products.length ? '' : '<p class="hint">เพิ่มสินค้าในสต็อกก่อน เพื่อผูกแคมเปญกับสินค้า</p>'}</form></details></div>
    <div class="panel"><div class="section-heading"><h2>แคมเปญของร้าน</h2><button id="ad-export" class="btn btn-ghost">ส่งออก CSV</button></div><div class="task-filters"><div class="field"><label>ค้นหาแคมเปญ / สินค้า</label><input id="ad-search" type="search" value="${esc(searchText)}"></div><div class="field"><label>สถานะแคมเปญ</label><select id="ad-filter"><option value="all">ทุกสถานะ</option>${Object.entries(phaseLabels).map(([key,label])=>`<option value="${key}" ${statusFilter===key?'selected':''}>${label}</option>`).join('')}</select></div></div><p class="hint" id="ad-count" role="status"></p>
    <div class="ad-list">${adCampaigns.map((c, index) => {
      const m = metrics[index], attached = products.filter(p => campaignHasProduct(c,p.id)), phase = campaignPhase(c,today,transactions);
      const eligible = transactions.filter(tx=>attached.some(p => saleMatchesProduct(tx,p)) && !tx.adCampaignId);
      const stat = (label,value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
      const plannedTable = attached.map(p => { const linkedProduct = productAdMetrics(p,adCampaigns,transactions,today); return `<h4>${esc(p.name)}</h4>` + `<div class="ad-table-scroll"><table><thead><tr><th>สี / ไซส์ / สภาพ</th><th>ต้นทุนซื้อ</th><th>รวมงบแอดต่อชิ้น*</th><th>ราคาขายตั้งไว้</th><th>กำไรคาดการณ์*</th></tr></thead><tbody>${p.variants.map(v=>`<tr><td>${esc([v.color,v.size,v.type==='used'?'มือสอง':'มือหนึ่ง',measurementLabel(v)].filter(Boolean).join(' · '))}</td><td>${fmt(v.cost)}</td><td>${fmt(v.cost+linkedProduct.plannedPerUnit)}</td><td>${fmt(v.price)}</td><td>${fmt(v.price-v.cost-linkedProduct.plannedPerUnit)}</td></tr>`).join('')}</tbody></table></div><p class="hint">* รวมงบต่อชิ้นของทุกแคมเปญสินค้านี้ที่เปิดใช้งานหรือยังไม่ถึงวันเริ่ม ใช้จำนวนเป้าหมายของแต่ละแคมเปญ ยังไม่หักค่าส่ง/ค่ากลาง หากขายไม่ถึงเป้า ต้นทุนแอดจริงต่อชิ้นจะสูงขึ้น</p>`; }).join('');
      return `<article class="ad-card" data-ad-id="${esc(c.id)}" data-ad-phase="${phase}" data-ad-search="${esc([c.name,...attached.map(p => p.name),c.channel,c.note].join(' ').toLowerCase())}">
        <header class="ad-card-header"><div><span class="tag preorder">${phaseLabels[phase]}</span><h3>${esc(c.name)}</h3><p>${esc(attached.map(p => p.name).join(', ') || 'ไม่พบสินค้า')} · ${esc(c.channel)}</p><p class="hint">${campaignUntilBudget(c) ? `เริ่ม ${c.startDate} · ยิงต่อเนื่องจนงบหมด · ไม่กำหนดวันสิ้นสุด` : `${c.startDate} ถึง ${c.endDate} · ${m.days} วัน · งบเฉลี่ย ${fmt(m.daily)}/วัน`}</p></div><div class="ad-card-actions">${attached.map(p => `<button class="btn btn-ghost" data-ad-product="${esc(p.id)}">ดูสินค้า${attached.length > 1 ? `: ${esc(p.name)}` : ''}</button>`).join('')}${safeAdUrl(c.url) ? `<a class="btn btn-ghost" href="${esc(safeAdUrl(c.url))}" target="_blank" rel="noopener noreferrer">เปิดโฆษณา ↗</a>` : ''}</div></header>
        <details class="ad-campaign-topup"><summary>+ เติมเงินเข้าแคมเปญ / ประวัติ (${adWallet.filter(e=>e.campaignId===c.id).length})</summary><p class="hint">ใส่ยอดที่เพิ่งเติมใน Ads Manager สำหรับแคมเปญนี้ ระบบเพิ่มงบแคมเปญและบันทึกเครดิตกลางครั้งเดียว ไม่ต้องกรอกยอดเดียวกันซ้ำในส่วนเติมเงินด้านบน</p><form class="ad-campaign-topup-form"><div class="form-grid ad-form-grid">${number('amount','จำนวนเงินที่เติมเพิ่ม (บาท)','',.01)}<div class="field"><label>วันที่เติมเงิน</label><input name="date" type="date" value="${today}" max="${today}" required></div><div class="field ad-wide"><label>หมายเหตุ / เลขอ้างอิง</label><input name="note" maxlength="500"></div></div><p class="hint ad-topup-preview" aria-live="polite"></p><button class="btn btn-primary" type="submit">เติมเงินเข้าแคมเปญ</button></form><p>เติมเข้าแคมเปญสะสม ${fmt(adWallet.filter(e=>e.campaignId===c.id).reduce((sum,e)=>sum+e.amount,0))}</p><ul class="ad-ledger">${adWallet.filter(e=>e.campaignId===c.id).map(e=>`<li><span>${e.date} · ${fmt(e.amount)}<small>${esc(e.note)}</small></span><button class="btn btn-ghost" data-ad-remove-topup="${esc(e.id)}">ลบรายการผิด</button></li>`).join('') || '<li>ยังไม่มีประวัติเติมเข้าแคมเปญ</li>'}</ul></details>
        ${c.note ? `<p class="ad-note">${esc(c.note)}</p>` : ''}
        <dl class="ad-metrics">${stat('งบทั้งหมด',fmt(c.budget))}${stat('งบที่ตั้งต่อวัน',c.dailyBudget == null ? 'ยังไม่ระบุ' : fmt(c.dailyBudget)+'/วัน')}${stat('งบคงเหลือพอประมาณ',m.estimatedDays == null ? 'ระบุงบต่อวันก่อน' : m.estimatedDays.toLocaleString('th-TH',{maximumFractionDigits:1})+' วัน')}${stat('จ่ายจริง',fmt(m.spend))}${stat('ค่าแอดใช้จริงวันนี้',fmt(m.spentToday))}${stat(m.remaining<0?'เกินงบ':'งบคงเหลือ',fmt(Math.abs(m.remaining)))}${stat('เป้าขาย / ขายที่ผูก',`${c.targetQty} / ${m.qty} ชิ้น`)}${stat('งบแอด / ชิ้นตามเป้า',fmt(m.plannedPerUnit))}${stat('ค่าแอดจริง / ชิ้นที่ขาย',m.actualPerUnit==null?'ยังไม่มียอดขาย':fmt(m.actualPerUnit))}${stat('ยอดขายที่ผูก',fmt(m.revenue))}${stat('กำไรก่อนหักแอด',fmt(m.grossProfit))}${stat('กำไรหลังหักแอด',fmt(m.net))}${stat('ยอดขาย ÷ ค่าแอด (ROAS)',m.roas==null?'—':m.roas.toFixed(2)+' เท่า')}</dl>
        ${phase==='active' && m.remaining>0 && m.daysLeft>0 ? `<p class="hint">เหลือ ${m.daysLeft} วันรวมวันนี้ · งบที่เหลือเฉลี่ย ${fmt(m.remaining/m.daysLeft)}/วัน</p>` : ''}
        ${m.remaining<0?'<p class="ad-warning" role="status">ค่าใช้จ่ายจริงเกินงบที่วางไว้แล้ว</p>':''}${phase==='exhausted'?'<p class="ad-warning">งบหมดตามค่าแอดที่บันทึกแล้ว ตรวจและหยุดแอดที่แพลตฟอร์ม หรือเพิ่มงบเพื่อยิงต่อ ระบบนี้ไม่ได้สั่งหยุดโฆษณาให้อัตโนมัติ</p>':''}${phase==='ended'?'<p class="ad-warning">ครบกำหนดแล้ว ตรวจยอดใช้จ่ายและเปลี่ยนสถานะเป็นจบแคมเปญเมื่อพร้อม</p>':''}
        <div class="ad-reserve"><strong>แนะนำแบ่งเก็บยิงแอดต่อ ${fmt(m.reserve)}</strong><p>กำไรตามเงินรับจริงหลังหักแอด ${fmt(m.cashNet)} × ${c.reservePercent}% · เฉลี่ย ${fmt(m.reservePerUnit)}/ชิ้นที่ขาย</p><p class="hint">หักต้นทุนของยอดขายทั้งหมดก่อนคำนวณ รวมยอดผ่อนที่ยังไม่ได้รับเงินด้วย ถ้ากำไรไม่เป็นบวกจะแนะนำเก็บ 0 บาท ตัวเลขนี้เป็นยอดแนะนำสะสม ยังไม่ได้หักเงินหรือบันทึกว่าเก็บจริง และไม่รับประกันผลยิงแอดรอบถัดไป</p></div>
        <details><summary>ต้นทุนสินค้ารวมแอดสำหรับวางราคา</summary><p class="hint">งบต่อชิ้น = งบรวม ÷ เป้าขายรวมทุกสินค้า สมมติแบ่งเป้าจำนวนเท่ากันแต่ละสินค้า ค่าแอดจริงแบ่งเท่ากันตามสินค้าที่แนบ ณ วันที่บันทึกค่าใช้จ่าย</p><ul class="ad-ledger">${attached.map(p => {const share = m.expenses.reduce((sum,tx) => sum + (adSpendAllocations(tx,c).find(a => a.productId === p.id)?.amount || 0),0); return `<li><span>${esc(p.name)}</span><strong>ค่าแอดแคมเปญนี้ ${fmt(share)}</strong></li>`;}).join('')}</ul>${plannedTable}</details>
        <section class="ad-daily-section"><div class="section-heading"><h4>ค่าใช้จ่ายรายวันของแคมเปญ</h4><button class="btn btn-ghost" data-ad-daily-export>ส่งออกค่าแอดรายวัน</button></div><div class="ad-table-scroll"><table class="ad-daily-table"><thead><tr><th>วันที่</th><th>ใช้จริงรวม</th><th>ใช้เครดิต</th><th>จ่ายตรง</th></tr></thead><tbody>${dailyAdSpend(c.id,transactions).map(day=>`<tr data-ad-day="${day.date}"><td>${day.date}</td><td>${fmt(day.amount)}</td><td>${fmt(day.wallet)}</td><td>${fmt(day.direct)}</td></tr>`).join('') || '<tr><td colspan="4">ยังไม่มีค่าแอดรายวัน</td></tr>'}</tbody></table></div><p class="hint">รวมค่าแอดทุกครั้งในวันเดียวกัน ใช้ยอดจริง ไม่คำนวณจากงบต่อวัน</p></section><details class="ad-spend-details"><summary>+ บันทึกค่าแอดรายวัน / ประวัติ (${m.expenses.length})</summary><form class="ad-spend-form"><div class="form-grid ad-form-grid">${number('amount','ค่าแอดที่ใช้เพิ่มในวันที่เลือก (บาท)','',.01)}<div class="field"><label>แหล่งชำระค่าแอด</label><select name="paymentSource"><option value="direct" ${adWallet.length ? '' : 'selected'}>จ่ายตรง / ไม่หักกระเป๋า</option><option value="wallet" ${adWallet.length ? 'selected' : ''}>หักเครดิต Ads Manager ที่เติมไว้</option></select></div><div class="field"><label>วันที่ใช้แอด / ลงบัญชี</label><input name="date" type="date" value="${today}" max="${today}" required></div><div class="field ad-wide"><label>หมายเหตุ / เลขใบเสร็จ</label><input name="note" maxlength="500"></div></div><p class="hint">ใส่ยอดที่จ่ายเพิ่มแต่ละครั้ง ไม่ใช่ยอดสะสมรวม บันทึกยอดใช้จริงรายวันหรือแต่ละรอบ ไม่ต้องบันทึกยอดเติมเงินซ้ำที่นี่ ค่าแอดหักกำไรในวันที่จ่ายจริง แม้จ่ายนอกช่วงแคมเปญ</p><p class="hint ad-day-preview" aria-live="polite"></p><button class="btn btn-primary" type="submit">บันทึกค่าแอดรายวัน</button></form><ul class="ad-ledger">${m.expenses.map(tx=>`<li><span>${tx.date} · ${fmt(tx.amount)}<small>${esc(tx.desc)} · ${tx.adWalletFunded ? 'หักเครดิต Ads Manager' : 'จ่ายตรง'}</small></span><button class="btn btn-ghost" data-ad-remove-spend="${esc(tx.id)}">ลบรายการผิด</button></li>`).join('') || '<li>ยังไม่มีค่าใช้จ่าย</li>'}</ul></details>
        <details class="ad-sales-details"><summary>ผูกยอดขาย / ผลลัพธ์ (${m.sales.length})</summary><p class="hint">เลือกแคมเปญตอนขาย หรือผูกยอดขายย้อนหลังที่นี่ แต่ละยอดขายผูกได้หนึ่งแคมเปญเท่านั้น ยอดขายระหว่างวันเริ่ม–สิ้นสุดไม่ได้ถือว่ามาจากแอดโดยอัตโนมัติ</p><form class="ad-link-form"><div class="field"><label>ยอดขายของสินค้าที่แนบและยังไม่ผูกแคมเปญ</label><select name="transactionId" required><option value="">เลือกยอดขาย</option>${eligible.map(tx=>`<option value="${esc(tx.id)}">${tx.date} · ${esc(tx.desc)} · ${fmt(tx.amount)}</option>`).join('')}</select></div><button class="btn btn-primary" type="submit">ผูกยอดขาย</button></form><ul class="ad-ledger">${m.sales.map(tx=>`<li><span>${tx.date} · ${fmt(tx.amount)} · ${tx.qty} ชิ้น<small>${esc(tx.desc)}${tx.type==='installment'?' · ผ่อนชำระ':''}</small></span><button class="btn btn-ghost" data-ad-unlink="${esc(tx.id)}">ยกเลิกการผูก</button></li>`).join('') || '<li>ยังไม่มียอดขายที่ผูก</li>'}</ul></details>
        <details class="ad-edit-details"><summary>แก้ไขแคมเปญ / สถานะ</summary><form class="ad-edit-form">${campaignFields(c,products,today,esc)}<button class="btn btn-primary" type="submit">บันทึกแคมเปญ</button></form><button class="btn btn-ghost danger-text" data-ad-delete>ลบแคมเปญที่ไม่มีประวัติ</button></details>
      </article>`;
    }).join('')}</div><div id="ad-empty" class="empty" hidden>ไม่มีแคมเปญที่ตรงกับตัวกรอง</div></div>`;
}
export function wireAds(state, { today, fmt, commit, confirm, alert, csv, openProduct }) {
  const create = document.getElementById('ad-create-form');
  if (!create) return;
  const values = form => {
    const data = new FormData(form), raw = Object.fromEntries(data);
    delete raw.extraProductId;
    const result = Object.fromEntries(Object.entries(raw).map(([k,v]) => [k,['budget','targetQty','reservePercent'].includes(k) ? Number(v) : v.trim()]));
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
  document.querySelectorAll('[data-ad-remove-topup]').forEach(button => button.onclick = () => run({type:'removeTopup', expectedWallet, entryId:button.dataset.adRemoveTopup, expected:JSON.stringify(state.adCampaigns.find(c=>c.id===(state.adWallet || []).find(e=>e.id===button.dataset.adRemoveTopup)?.campaignId))}, 'ลบบันทึกเติมเงินที่ผิด? เครดิตคงเหลือจะคำนวณใหม่ หากเติมเข้าแคมเปญจะลดงบกลับตามยอดที่เติม การลบนี้ไม่ได้คืนเงินจริงจาก Ads Manager'));
  document.getElementById('ad-wallet-export').onclick = () => csv('ads-topups', [['วันที่','ยอดเติม (บาท)','หมายเหตุ','แคมเปญ','งบที่เพิ่ม'],...(state.adWallet || []).map(e=>[e.date,e.amount,e.note,state.adCampaigns.find(c=>c.id===e.campaignId)?.name || 'เครดิตกลาง',e.budgetIncrease || 0])]);
  const preview = form => {
    const untilBudget = form.elements.namedItem('runMode').value === 'until_budget';
    form.querySelector('.ad-end-field').hidden = untilBudget;
    const end = form.elements.namedItem('endDate'); end.disabled = untilBudget; end.required = !untilBudget;
    form.querySelectorAll('[name="extraProductId"]').forEach(input => {
      input.disabled = input.value === form.elements.namedItem('productId').value;
      if (input.disabled) input.checked = false;
    });
    const v=values(form);
    form.querySelector('.ad-plan-preview').textContent = v.targetQty>0 && v.budget>=0 ? `งบแอดต่อชิ้นตามเป้า ${fmt(v.budget/v.targetQty)} · แบ่งเก็บ ${v.reservePercent}% ของกำไรตามเงินรับจริงหลังหักแอด${v.dailyBudget>0 ? ' · งบรวมพอประมาณ '+(v.budget/v.dailyBudget).toLocaleString('th-TH',{maximumFractionDigits:1})+' วัน ตามงบต่อวันที่ตั้ง' : ''}` : 'ระบุงบและจำนวนเป้าหมายเพื่อดูต้นทุนแอดต่อชิ้น';
  };
  document.querySelectorAll('#ad-create-form, .ad-edit-form').forEach(form=> {form.addEventListener('input',()=>preview(form)); form.addEventListener('change',()=>preview(form)); preview(form);});
  create.onsubmit = e => { e.preventDefault(); run({type:'create',values:values(create)}); };
  document.querySelectorAll('[data-ad-id]').forEach(card=>{
    const c=state.adCampaigns.find(c=>c.id===card.dataset.adId), expected=JSON.stringify(c);
    const action = (type, extra={})=>({type,campaignId:c.id,expected,...extra});
    const topupForm=card.querySelector('.ad-campaign-topup-form');
    const previewTopup=()=>{const amount=Number(topupForm.elements.namedItem('amount').value);topupForm.querySelector('.ad-topup-preview').textContent=`งบเดิม ${fmt(c.budget)} · งบหลังเติม ${fmt(c.budget+(Number.isFinite(amount)&&amount>0?amount:0))}`;};
    topupForm.addEventListener('input',previewTopup);previewTopup();
    topupForm.onsubmit=e=>{e.preventDefault();const data=new FormData(topupForm);run(action('topup',{expectedWallet,amount:Number(data.get('amount')),date:data.get('date'),note:data.get('note').trim()}));};
    card.querySelector('.ad-edit-form').onsubmit = e=>{e.preventDefault();run(action('edit',{values:values(e.currentTarget)}));};
    card.querySelector('.ad-spend-form').onsubmit = e=>{e.preventDefault();const data=new FormData(e.currentTarget);run(action('spend',{amount:Number(data.get('amount')),date:data.get('date'),note:data.get('note').trim(),adWalletFunded:data.get('paymentSource')==='wallet'}));};
    const spendForm = card.querySelector('.ad-spend-form');
    const previewDay = () => {
      const date = spendForm.elements.namedItem('date').value;
      const existing = dailyAdSpend(c.id,state.transactions).find(d=>d.date===date)?.amount || 0;
      const amount = Number(spendForm.elements.namedItem('amount').value);
      spendForm.querySelector('.ad-day-preview').textContent = `วันที่เลือกบันทึกแล้ว ${fmt(existing)} · รวมหลังบันทึก ${fmt(existing + (Number.isFinite(amount) && amount>0 ? amount : 0))} · กรอกเฉพาะยอดที่ยังไม่ได้บันทึก`;
    };
    spendForm.addEventListener('input',previewDay); spendForm.addEventListener('change',previewDay); previewDay();
    card.querySelector('[data-ad-daily-export]').onclick = () => csv('ads-daily', [['แคมเปญ','วันที่','ค่าแอดรวม','ใช้เครดิต','จ่ายตรง'],...dailyAdSpend(c.id,state.transactions).map(d=>[c.name,d.date,d.amount,d.wallet,d.direct])]);
    card.querySelector('.ad-link-form').onsubmit = e=>{e.preventDefault();const transactionId=new FormData(e.currentTarget).get('transactionId');run(action('link',{transactionId,expectedTransaction:JSON.stringify(state.transactions.find(tx=>tx.id===transactionId))}));};
    [['[data-ad-remove-spend]','adRemoveSpend','removeSpend','ลบค่าแอดที่บันทึกผิด? ระบบจะนำรายจ่ายนี้ออกและคำนวณกำไรใหม่'],['[data-ad-unlink]','adUnlink','unlink','ยกเลิกการผูกยอดขายกับแคมเปญนี้? ยอดขายและสต็อกยังคงเดิม']].forEach(([selector,key,type,question])=>card.querySelectorAll(selector).forEach(button=>button.onclick=()=>{const transactionId=button.dataset[key];run(action(type,{transactionId,expectedTransaction:JSON.stringify(state.transactions.find(tx=>tx.id===transactionId))}),question);}));
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
    csv('ads', [['แคมเปญ','สินค้า','ช่องทาง','สถานะ','เริ่ม','สิ้นสุด','งบ','งบต่อวัน','เป้าจำนวน','จ่ายจริง','ยอดขายที่ผูก','จำนวนขาย','กำไรก่อนแอด','กำไรหลังแอด','กำไรตามเงินรับหลังแอด','เก็บต่อ %','แนะนำเก็บสะสม','ROAS'],...state.adCampaigns.filter(c=>ids.has(c.id)).map(c=>{const m=adMetrics(c,state.transactions,today);return[c.name,state.products.filter(p=>campaignHasProduct(c,p.id)).map(p=>p.name).join(' / '),c.channel,phaseLabels[campaignPhase(c,today,state.transactions)],c.startDate,campaignUntilBudget(c)?'จนงบหมด':c.endDate,c.budget,c.dailyBudget??'',c.targetQty,m.spend,m.revenue,m.qty,m.grossProfit,m.net,m.cashNet,c.reservePercent,m.reserve,m.roas??''];})]);
  };
}
