import { deliveryLabels, pendingDeliveries } from './shipments.js';

export function renderShipments({transactions,shipments=[]},{esc,today,fmt,metric}) {
  const pending = pendingDeliveries(transactions,shipments);
  const outstanding = tx => tx.type === 'installment' ? Math.max(0,tx.amount-(tx.paidAmount || 0)) : 0;
  return `<section class="stats">${metric('สินค้ารอส่ง',pending.reduce((n,r)=>n+r.remaining,0)+' ชิ้น',pending.length+' รายการขาย','box')}${metric('พัสดุที่ส่งแล้ว',shipments.filter(s=>s.status==='shipped').length,'รวมพัสดุที่ยังไม่ยกเลิกการบันทึก','check')}</section>
    <section class="panel"><div class="section-heading"><h2>รอส่งสินค้า</h2><button class="btn btn-ghost" data-go="sell">บันทึกการขายเพิ่ม</button></div>
    <p class="hint">เลือกหลายรายการเพื่อแนบในพัสดุเดียวกัน เลือกเฉพาะของที่จะส่งให้ผู้รับเดียวกัน ระบุจำนวนที่จะส่งได้หากส่งบางส่วน การส่งไม่ตัดสต็อกหรือรับเงินซ้ำ รายการผ่อนแสดงยอดค้างให้ตรวจสอบก่อนส่ง</p>
    <form id="shipment-form"><div class="field"><label for="shipment-search">ค้นหาสินค้า / ลูกค้า / รหัสขาย</label><input id="shipment-search" type="search" placeholder="ค้นหารายการรอส่ง"></div>
    <div class="shipment-selection-tools"><label><input id="shipment-select-all" type="checkbox"> เลือกทุกรายการที่แสดง</label><button id="shipment-clear" class="btn btn-ghost btn-sm" type="button">ล้างที่เลือก</button></div>
    <div class="shipment-pending-list">${pending.map(({sale:tx,shipped,remaining})=>`<article class="shipment-pending-row" data-pending-sale="${esc(tx.id)}" data-search="${esc([tx.id,tx.desc,tx.customerNote].join(' ').toLowerCase())}">
      <label class="shipment-item-label"><input class="shipment-select" type="checkbox" value="${esc(tx.id)}"><span><strong>${esc(tx.desc || 'รายการขาย')}</strong><small>${esc(tx.customerNote || 'ยังไม่ระบุผู้รับ')} · ขาย ${tx.date} · รหัส ${esc(tx.id)}</small><span class="tag preorder">${deliveryLabels[tx.deliveryStatus]} · เหลือส่ง ${remaining} ชิ้น</span><small>ขาย ${tx.qty} · ส่งแล้ว ${shipped} ชิ้น${outstanding(tx)>0 ? ` · ค้างชำระ ${fmt(outstanding(tx))}` : ''}</small></span></label>
      <div class="field"><label for="send-qty-${esc(tx.id)}">จำนวนที่จะส่ง</label><input id="send-qty-${esc(tx.id)}" class="shipment-qty" type="number" min="1" max="${remaining}" step="1" value="${remaining}" disabled required></div>
    </article>`).join('')}</div><p id="shipment-empty" class="hint" ${pending.length ? 'hidden' : ''}>ไม่มีสินค้ารอส่งที่ตรงกับการค้นหา</p>
    <p id="shipment-selection-summary" class="hint" aria-live="polite"></p>
    <div class="form-grid"><div class="field"><label for="shipment-recipient">ผู้รับ / เลขคำสั่งซื้อ (ถ้ามี)</label><input id="shipment-recipient" name="recipient" maxlength="2000"></div>
    <div class="field"><label for="shipment-date">วันที่ส่ง</label><input id="shipment-date" name="date" type="date" value="${today}" max="${today}" required></div>
    <div class="field"><label for="shipment-carrier">ขนส่ง (ถ้ามี)</label><input id="shipment-carrier" name="carrier" maxlength="80" placeholder="เช่น ไปรษณีย์ไทย"></div>
    <div class="field"><label for="shipment-tracking">เลขพัสดุ (ถ้ามี)</label><input id="shipment-tracking" name="trackingNumber" maxlength="120"></div>
    <div class="field"><label for="shipment-note">หมายเหตุ</label><textarea id="shipment-note" name="note" maxlength="1000" rows="2"></textarea></div></div>
    <button id="shipment-submit" class="btn btn-primary" type="submit" disabled>ส่งสินค้าแล้ว</button></form>
    <p class="hint">ยอดขายเก่าที่ยังไม่มีสถานะจัดส่งไม่ถูกนำมาขึ้นรอส่งอัตโนมัติ ส่วน pre-order ที่กดยืนยันส่งมอบแล้วจัดการอยู่ในประวัติ pre-order</p></section>
    <section class="panel"><div class="section-heading"><h2>ประวัติการส่งสินค้า</h2><button id="shipment-export" class="btn btn-ghost">ส่งออกการจัดส่ง CSV</button></div>
    <div class="shipment-history">${shipments.map(s=>`<article class="shipment-history-card" data-shipment-id="${esc(s.id)}"><div class="section-heading"><h3>${esc(s.recipient || 'พัสดุ '+s.id)}</h3><span class="tag ${s.status==='cancelled'?'expense':'income'}">${s.status==='cancelled'?'ยกเลิกการบันทึกส่ง':'ส่งสินค้าแล้ว'}</span></div>
      <p>${s.date} · ${esc(s.carrier || 'ไม่ระบุขนส่ง')} · เลขพัสดุ ${esc(s.trackingNumber || 'ยังไม่ระบุ')}</p>${s.note ? `<p>${esc(s.note)}</p>` : ''}
      <ul>${s.items.map(i=>`<li>${esc(transactions.find(tx=>tx.id===i.saleId)?.desc || i.saleId)} — ส่ง ${i.qty} ชิ้น</li>`).join('')}</ul>
      ${s.status==='shipped'?`<button class="btn btn-ghost" data-shipment-cancel="${esc(s.id)}">ยกเลิกการบันทึกส่ง</button>`:`<p class="hint">ยกเลิกเมื่อ ${s.cancelledAt} · นำจำนวนกลับเข้ารอส่งแล้ว</p>`}</article>`).join('') || '<p class="hint">ยังไม่มีประวัติการส่งสินค้า</p>'}</div></section>`;
}

export function wireShipments(state,{commit,confirm,alert,csv}) {
  const form = document.getElementById('shipment-form');
  if (!form) return;
  const rows = [...form.querySelectorAll('[data-pending-sale]')];
  const selected = () => rows.filter(r=>r.querySelector('.shipment-select').checked);
  const all = document.getElementById('shipment-select-all');
  const update = () => {
    const picked = selected(), visible = rows.filter(r=>!r.hidden);
    rows.forEach(r=>{r.querySelector('.shipment-qty').disabled=!r.querySelector('.shipment-select').checked;});
    document.getElementById('shipment-submit').disabled=!picked.length;
    document.getElementById('shipment-selection-summary').textContent=`เลือก ${picked.length} รายการ · ${picked.reduce((sum,r)=>sum+(Number(r.querySelector('.shipment-qty').value)||0),0)} ชิ้น${picked.some(r=>r.hidden)?' (รวมรายการที่อยู่นอกผลค้นหา)':''}`;
    all.checked=visible.length>0 && visible.every(r=>r.querySelector('.shipment-select').checked);
    all.indeterminate=!all.checked && visible.some(r=>r.querySelector('.shipment-select').checked);
    all.disabled=!visible.length;
    document.getElementById('shipment-empty').hidden=visible.length>0;
  };
  form.addEventListener('input',e=>{if(e.target !== all) update();});
  form.addEventListener('change',e=>{if(e.target !== all) update();});
  all.onchange=()=>{rows.filter(r=>!r.hidden).forEach(r=>{r.querySelector('.shipment-select').checked=all.checked;});update();};
  document.getElementById('shipment-clear').onclick=()=>{rows.forEach(r=>{r.querySelector('.shipment-select').checked=false;});update();};
  document.getElementById('shipment-search').oninput=e=>{rows.forEach(r=>{r.hidden=!r.dataset.search.includes(e.target.value.trim().toLowerCase());});update();};
  const expectedSales = ids => Object.fromEntries(ids.map(id=>[id,JSON.stringify(state.transactions.find(tx=>tx.id===id))]));
  const run = async(action,question) => {try {if (await confirm(question)) await commit({...action,expectedShipments:JSON.stringify(state.shipments || [])});} catch(e) {if (!e.storageReported) alert(e.message);}};
  form.onsubmit=e=>{
    e.preventDefault(); const items=selected().map(r=>({saleId:r.dataset.pendingSale,qty:Number(r.querySelector('.shipment-qty').value)}));
    if (!items.length) {alert('เลือกสินค้าที่รอส่งอย่างน้อย 1 รายการ');return;}
    const values=Object.fromEntries([...new FormData(form)].map(([k,v])=>[k,String(v).trim()])); values.items=items;
    run({type:'ship',values,expectedSales:expectedSales(items.map(i=>i.saleId))},`ยืนยันส่งสินค้าแล้ว ${items.reduce((n,i)=>n+i.qty,0)} ชิ้น รวม ${items.length} รายการ ในพัสดุเดียวกัน?\nผู้รับ: ${values.recipient || 'ยังไม่ระบุ'}\nวันที่: ${values.date} · เลขพัสดุ: ${values.trackingNumber || 'ยังไม่ระบุ'}\n${items.map(i=>`${state.transactions.find(tx=>tx.id===i.saleId)?.desc} — ส่ง ${i.qty} ชิ้น`).join('\n')}\nจะไม่ตัดสต็อกหรือบันทึกรายรับซ้ำ`);
  };
  document.querySelectorAll('[data-shipment-cancel]').forEach(button=>button.onclick=()=>{
    const shipment=state.shipments.find(s=>s.id===button.dataset.shipmentCancel);
    run({type:'cancel',shipmentId:shipment.id,expectedShipment:JSON.stringify(shipment),expectedSales:expectedSales(shipment.items.map(i=>i.saleId))},'ยกเลิกการบันทึกส่งพัสดุนี้? จำนวนจะกลับเข้ารอส่ง โดยไม่คืนสต็อกหรือเงิน และยังเก็บประวัติการยกเลิกไว้');
  });
  document.getElementById('shipment-export').onclick=()=>csv('shipments',[['รหัสพัสดุ','สถานะ','วันที่ส่ง','ผู้รับ','ขนส่ง','เลขพัสดุ','รหัสขาย','สินค้า','จำนวนส่ง','หมายเหตุ'],...state.shipments.flatMap(s=>s.items.map(i=>[s.id,s.status,s.date,s.recipient,s.carrier,s.trackingNumber,i.saleId,state.transactions.find(tx=>tx.id===i.saleId)?.desc || '',i.qty,s.note]))]);
  update();
}
