// Synthetic records only. This seed is never included in the production build.
module.exports = function previewData() {
  const date = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Bangkok'}).format(new Date());
  const day = offset => {const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
  const products=[
    {id:'demo-tee',name:'Essential Tee',image:null,colorImages:{},createdAt:day(-45),variants:[{id:'demo-black-m',color:'ดำ',size:'M',type:'new',qty:18,cost:160,price:390,createdAt:day(-45)},{id:'demo-black-l',color:'ดำ',size:'L',type:'new',qty:8,cost:160,price:390,createdAt:day(-45)},{id:'demo-white-l',color:'ขาว',size:'L',type:'new',qty:6,cost:160,price:390,createdAt:day(-45)}]},
    {id:'demo-vintage',name:'Vintage Wash',image:null,colorImages:{},createdAt:day(-30),variants:[{id:'demo-vintage-xl',color:'ฟอก',size:'XL',type:'used',qty:1,cost:240,price:590,chestInches:23,lengthInches:29,createdAt:day(-30)}]},
    {id:'demo-hoodie',name:'Everyday Hoodie',image:null,colorImages:{},createdAt:day(-20),variants:[{id:'demo-hoodie-m',color:'ครีม',size:'M',type:'new',qty:3,cost:380,price:890,createdAt:day(-20)}]}
  ];
  const transactions=[];
  for(let i=0;i<18;i++){
    const p=products[i%3],v=p.variants[0],qty=i%2+1;
    const installment=i===0;
    transactions.push({id:'demo-sale-'+i,type:installment?'installment':'income',category:'ขายสินค้า',desc:p.name+' · '+v.color+' '+v.size+' x'+qty,amount:v.price*qty,date:day(-i*7),productId:v.id,stockProductId:p.id,qty,unitPrice:v.price,unitCost:v.cost,shipping:0,commission:0,profit:(v.price-v.cost)*qty,personalUsePercent:10,customerNote:i%2?'คุณเมย์ (ตัวอย่าง)':'คุณพิม (ตัวอย่าง)',...(i<3?{deliveryStatus:'pending'}:{}),...(installment?{paidAmount:100,dueDate:day(7)}:{})});
  }
  transactions.push({id:'demo-payment',type:'income',category:'รับชำระค่าผ่อน (มัดจำแรก)',desc:'คุณพิม (ตัวอย่าง)',amount:100,date,installmentId:'demo-sale-0',productId:'demo-black-m'});
  const pendingOrders=[{id:'demo-purchase-1',name:'Essential Tee',productId:'demo-tee',color:'ดำ',size:'L',type:'new',qty:8,cost:160,price:390,orderDate:day(-3),note:'จ่ายแล้ว · ผู้ขาย A · ตัวอย่าง',image:null},{id:'demo-purchase-2',name:'Everyday Hoodie',productId:'demo-hoodie',color:'ครีม',size:'M',type:'new',qty:5,cost:380,price:890,orderDate:day(-3),note:'จ่ายแล้ว · ผู้ขาย A · ตัวอย่าง',image:null}];
  transactions.unshift({id:'demo-purchase',type:'expense',category:'สั่งซื้อสินค้า (รอของมาส่ง)',desc:'รายการตัวอย่าง จ่ายแล้วรอรับ',amount:3180,date:day(-3),pendingIds:pendingOrders.map(o=>o.id),purchaseItems:structuredClone(pendingOrders)});
  const preorders=[{id:'demo-preorder',customer:'คุณฟ้า (ตัวอย่าง)',contact:'ตัวอย่าง',name:'Everyday Hoodie',color:'ครีม',size:'L',type:'new',qty:1,unitPrice:890,paidAmount:300,refundedAmount:0,note:'รับจองรอบใหม่',dueDate:day(7),createdAt:day(-2),updatedAt:day(-2),status:'awaiting'}];
  transactions.unshift({id:'demo-preorder-deposit',type:'income',category:'มัดจำ pre-order',amount:300,date:day(-2),preorderId:'demo-preorder',desc:'มัดจำคุณฟ้า (ตัวอย่าง)'});
  return {products,transactions,pendingOrders,preorders,shipments:[],adWallet:[],adCampaigns:[{id:'demo-campaign',name:'October Essentials',productId:'demo-tee',channel:'Facebook',status:'active',startDate:date,endDate:day(7),targetQty:10,reservePercent:20,reservePerUnit:35,note:'ตัวอย่าง',url:''}]};
};
