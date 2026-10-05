import { cancellationRefundDue, deliveryLabels, pendingDeliveries } from './shipments.js';

export function renderShipmentAllocation(allocation, {esc, fmt}) {
  return `<div class="shipment-allocation"><p>ยอดขายสินค้าที่ส่งครั้งนี้ <strong>${fmt(allocation.revenue)}</strong></p><div class="shipment-allocation-totals"><p>ควรแบ่งยิงแอด <strong data-allocation-ads>${fmt(allocation.adReserve)}</strong></p><p>แบ่งใช้ส่วนตัว <strong data-allocation-personal>${fmt(allocation.personalAmount)}</strong></p></div><p class="hint">เงินใช้ส่วนตัวคิดจากยอดขายเต็มก่อนหักค่าใช้จ่าย ตาม % ของแต่ละรายการ เฉพาะจำนวนที่ส่งครั้งนี้ เป็นยอดแนะนำ ยังไม่บันทึกถอนเงินหรือเติมเครดิตแอด</p>${allocation.items.some(item => item.outstanding > 0) ? '<p class="hint">มีรายการผ่อนที่ยังรับเงินไม่ครบ ยอดแบ่งนี้เป็นแผนตามยอดขายเต็ม</p>' : ''}<details><summary>รายละเอียดแบ่งเงินรายรายการ</summary>${allocation.items.map(item => `<p>${esc(item.description || item.saleId)} · ส่ง ${item.qty} ชิ้น · แอด ${fmt(item.adReserve)} · ใช้ส่วนตัว ${item.personalPercent}% = ${fmt(item.personalAmount)}</p>`).join('')}</details></div>`;
}

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
      <div class="field"><label for="send-qty-${esc(tx.id)}">จำนวนที่จะส่ง</label><input id="send-qty-${esc(tx.id)}" class="shipment-qty" type="number" min="1" max="${remaining}" step="1" value="${remaining}" disabled required>${shipped===0 && tx.type !== 'preorder' ? `<label for="cancel-reason-${esc(tx.id)}">เหตุผลยกเลิก (ถ้ามี)</label><input id="cancel-reason-${esc(tx.id)}" class="cancel-sale-reason" maxlength="500"><button type="button" class="btn btn-ghost danger-text" data-cancel-sale="${esc(tx.id)}">ยกเลิกการขาย / คืนสต็อก</button>` : '<small class="hint">ติดตามการจัดส่งสินค้าได้จากประวัติพัสดุ</small>'}</div>
    </article>`).join('')}</div><p id="shipment-empty" class="hint" ${pending.length ? 'hidden' : ''}>ไม่มีสินค้ารอส่งที่ตรงกับการค้นหา</p>
    <p id="shipment-selection-summary" class="hint" aria-live="polite"></p>
    <div class="form-grid"><div class="field"><label for="shipment-recipient">ผู้รับ / เลขคำสั่งซื้อ (ถ้ามี)</label><input id="shipment-recipient" name="recipient" maxlength="2000"></div>
    <div class="field"><label for="shipment-date">วันที่ส่ง</label><input id="shipment-date" name="date" type="date" value="${today}" max="${today}" required></div>
    <div class="field"><label for="shipment-carrier">ขนส่ง (ถ้ามี)</label><input id="shipment-carrier" name="carrier" maxlength="80" placeholder="เช่น ไปรษณีย์ไทย"></div>
    <div class="field"><label for="shipment-tracking">เลขพัสดุ (ถ้ามี)</label><input id="shipment-tracking" name="trackingNumber" maxlength="120"></div>
    <div class="field"><label for="shipment-cost">ค่าส่งเพิ่มของพัสดุนี้ (บาท)</label><input id="shipment-cost" name="shippingCost" type="number" min="0" max="1000000000000" step="0.01" value="0" required><small class="hint">ยอดรวมสำหรับทุกรายการที่เลือก แบ่งตามจำนวนชิ้น ลงรายจ่ายครั้งเดียวและหักกำไรสินค้า กรอกเฉพาะค่าส่งที่ยังไม่ได้ลงตอนขาย</small></div>
    <div class="field"><label for="shipment-note">หมายเหตุ</label><textarea id="shipment-note" name="note" maxlength="1000" rows="2"></textarea></div></div>
    <button id="shipment-submit" class="btn btn-primary" type="submit" disabled>ส่งสินค้าแล้ว</button></form>
    <p class="hint">ยอดขายเก่าที่ยังไม่มีสถานะจัดส่งไม่ถูกนำมาขึ้นรอส่งอัตโนมัติ พรีออเดอร์ที่ยืนยันของถึงและชำระครบแล้วจะเข้ารอส่งที่นี่</p></section>
    <section class="panel"><h2>รายการขายที่ยกเลิก</h2><p class="hint">คืนสินค้าเข้าสต็อกแล้ว รายการที่รับเงินจากลูกค้ายังรอคืนเงิน กดบันทึกคืนเงินแล้วเมื่อคืนเงินจริง การกดปุ่มนี้ไม่โอนเงินให้อัตโนมัติ</p>${transactions.filter(t=>t.deliveryStatus==='cancelled').map(t=>`<article class="shipment-history-card" data-cancelled-sale="${esc(t.id)}"><h3>${esc(t.desc)}</h3><p>ยกเลิก ${t.cancelledAt} · คืนสต็อก ${t.qty} ชิ้น</p><p>${esc(t.cancellationReason || 'ไม่ระบุเหตุผล')}</p><p>รอคืนเงิน ${fmt(t.refundDue-t.refundedAmount)} · คืนแล้ว ${fmt(t.refundedAmount)}</p>${t.refundDue>t.refundedAmount ? `<button class="btn btn-primary" data-refund-sale="${esc(t.id)}">บันทึกคืนเงินแล้ว ${fmt(t.refundDue-t.refundedAmount)}</button>` : '<span class="tag income">ไม่มีเงินรอคืน</span>'}</article>`).join('') || '<p class="hint">ยังไม่มีรายการขายที่ยกเลิก</p>'}</section>
    <section class="panel"><div class="section-heading"><h2>ประวัติการส่งสินค้า</h2><button id="shipment-export" class="btn btn-ghost">ส่งออกการจัดส่ง CSV</button></div>
    <div class="shipment-history">${shipments.map(s=>`<article class="shipment-history-card" data-shipment-id="${esc(s.id)}"><div class="section-heading"><h3>${esc(s.recipient || 'พัสดุ '+s.id)}</h3><span class="tag ${s.status==='cancelled'?'expense':'income'}">${s.status==='cancelled'?'ยกเลิกการบันทึกส่ง':'ส่งสินค้าแล้ว'}</span></div>
      <p>${s.date} · ${esc(s.carrier || 'ไม่ระบุขนส่ง')} · เลขพัสดุ ${esc(s.trackingNumber || 'ยังไม่ระบุ')}</p>${s.note ? `<p>${esc(s.note)}</p>` : ''}
      <ul>${s.items.map(i=>`<li>${esc(transactions.find(tx=>tx.id===i.saleId)?.desc || i.saleId)} — ส่ง ${i.qty} ชิ้น</li>`).join('')}</ul>
      ${s.allocation && s.status === 'shipped' ? `<h4>ยอดแบ่งเงิน ณ ตอนส่งพัสดุนี้</h4>${renderShipmentAllocation(s.allocation, {esc, fmt})}` : ''}
      <div class="field"><label for="shipment-cost-${esc(s.id)}">ค่าส่งพัสดุนี้ (บาท)</label><input id="shipment-cost-${esc(s.id)}" class="shipment-history-cost" type="number" min="0" max="1000000000000" step="0.01" value="${s.shippingCost || 0}"><button type="button" class="btn btn-ghost" data-shipment-cost="${esc(s.id)}">แก้ไขค่าส่ง</button><small class="hint">แก้ยอดรวมของพัสดุนี้ ใส่ 0 เพื่อลบค่าส่งที่ลงผิด ไม่กระทบค่าส่งที่บันทึกตอนขาย</small></div>
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
  document.querySelectorAll('[data-cancel-sale]').forEach(button=>button.onclick=()=>{
    const tx=state.transactions.find(t=>t.id===button.dataset.cancelSale);
    const reason=button.closest('[data-pending-sale]').querySelector('.cancel-sale-reason').value.trim();
    run({type:'cancelSale',saleId:tx.id,reason,expectedSales:expectedSales([tx.id])},`ยกเลิกการขาย ${tx.desc}?\nคืนสินค้า ${tx.qty} ชิ้นเข้าสต็อก และตัดยอดขาย/หนี้ค้างชำระออก\nเงินที่รับแล้ว ${cancellationRefundDue(tx)} บาทจะอยู่ในรายการรอคืนเงิน\nค่าส่ง ค่ากลาง และค่าแอดที่จ่ายแล้วจะยังคงอยู่ในบัญชี`);
  });
  document.querySelectorAll('[data-refund-sale]').forEach(button=>button.onclick=()=>{const tx=state.transactions.find(t=>t.id===button.dataset.refundSale);run({type:'refundSale',saleId:tx.id,expectedSales:expectedSales([tx.id])},`ยืนยันว่าคืนเงินให้ลูกค้าจริงแล้ว ${tx.refundDue-tx.refundedAmount} บาท? ระบบจะบันทึกรายจ่ายคืนเงินวันนี้`);});
  form.onsubmit=e=>{
    e.preventDefault(); const items=selected().map(r=>({saleId:r.dataset.pendingSale,qty:Number(r.querySelector('.shipment-qty').value)}));
    if (!items.length) {alert('เลือกสินค้าที่รอส่งอย่างน้อย 1 รายการ');return;}
    const values=Object.fromEntries([...new FormData(form)].map(([k,v])=>[k,String(v).trim()])); values.items=items;
    values.shippingCost=Number(values.shippingCost);
    run({type:'ship',values,expectedSales:expectedSales(items.map(i=>i.saleId))},`ยืนยันส่งสินค้าแล้ว ${items.reduce((n,i)=>n+i.qty,0)} ชิ้น รวม ${items.length} รายการ ในพัสดุเดียวกัน?\nผู้รับ: ${values.recipient || 'ยังไม่ระบุ'}\nวันที่: ${values.date} · เลขพัสดุ: ${values.trackingNumber || 'ยังไม่ระบุ'}\n${items.map(i=>`${state.transactions.find(tx=>tx.id===i.saleId)?.desc} — ส่ง ${i.qty} ชิ้น`).join('\n')}\nบันทึกค่าส่งเพิ่ม ${values.shippingCost} บาทครั้งเดียว แบ่งตามจำนวนชิ้น\nจะไม่ตัดสต็อกหรือบันทึกรายรับซ้ำ`);
  };
  document.querySelectorAll('[data-shipment-cancel]').forEach(button=>button.onclick=()=>{
    const shipment=state.shipments.find(s=>s.id===button.dataset.shipmentCancel);
    run({type:'cancel',shipmentId:shipment.id,expectedShipment:JSON.stringify(shipment),expectedSales:expectedSales(shipment.items.map(i=>i.saleId))},'ยกเลิกการบันทึกส่งพัสดุนี้? จำนวนจะกลับเข้ารอส่ง โดยไม่คืนสต็อกหรือเงิน ค่าส่งยังคงอยู่ หากลงผิดให้แก้ค่าส่งเป็น 0 ในประวัติพัสดุ และยังเก็บประวัติการยกเลิกไว้');
  });
  document.querySelectorAll('[data-shipment-cost]').forEach(button=>button.onclick=()=>{
    const shipment=state.shipments.find(s=>s.id===button.dataset.shipmentCost);
    const amount=Number(button.closest('[data-shipment-id]').querySelector('.shipment-history-cost').value);
    run({type:'shippingCost',shipmentId:shipment.id,amount,expectedShipment:JSON.stringify(shipment),expectedSales:expectedSales(shipment.items.map(i=>i.saleId))},`แก้ค่าส่งรวมพัสดุนี้เป็น ${amount} บาท? ระบบปรับรายจ่ายและกำไรของรายการที่แนบ โดยไม่เปลี่ยนสต็อก`);
  });
  document.getElementById('shipment-export').onclick=()=>csv('shipments',[['รหัสพัสดุ','สถานะ','วันที่ส่ง','ผู้รับ','ขนส่ง','เลขพัสดุ','รหัสขาย','สินค้า','จำนวนส่ง','ค่าส่งส่วนของรายการนี้','หมายเหตุ'],...state.shipments.flatMap(s=>s.items.map(i=>[s.id,s.status,s.date,s.recipient,s.carrier,s.trackingNumber,i.saleId,state.transactions.find(tx=>tx.id===i.saleId)?.desc || '',i.qty,i.shippingShare||0,s.note]))]);
  update();
}
