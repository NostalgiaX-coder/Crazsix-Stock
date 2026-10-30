const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const seed=require('./preview-data');
const root=path.resolve(__dirname,'..');
const port=Number(process.env.PREVIEW_PORT||4174);
const modules=['app','sales','stock-history','theme','ads','ads-ui','preorders','store-tools','inventory-tools','ui-accessibility','receiving-lots','receiving-ui','shipments','shipments-ui','sale-finance','profit-ui'];
const allowed=new Set(['index.html','css/styles.css','assets/fonts/inter-latin.woff2','assets/fonts/noto-sans-thai.woff2','assets/crazsix-logo.png','assets/crazsix-logo-banner.png',...modules.map(name=>'js/'+name+'.js')]);
const adapter=()=>`
  const state=${JSON.stringify(seed())};
  const copy=value=>structuredClone(value);
  export const firebaseConfigured=true;
  export const stockDatabase={
    async get(name){return copy(state[name]??[]);},
    async set(name,value){state[name]=copy(value);},
    async setMany(values,expected){
      for(const name of Object.keys(values))if(JSON.stringify(state[name]??[])!==JSON.stringify(expected[name]??[])){const error=new Error('Preview conflict');error.code='store/conflict';throw error;}
      Object.assign(state,copy(values));
    },
    subscribe(){return ()=>{};}
  };
`;
http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1'),name=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';
    let body,type;
    if(name==='js/firebase-service.js'){body=adapter();type='text/javascript';}
    else if(name==='preview-chart.js'){body=await fs.readFile(path.join(path.dirname(require.resolve('chart.js')),'chart.umd.js'));type='text/javascript';}
    else {
      if(!allowed.has(name)){res.writeHead(404).end('Not found');return;}
      body=await fs.readFile(path.join(root,name));
      type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.woff2':'font/woff2'}[path.extname(name)];
      if(name==='index.html')body=body.toString().replace('https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.4.4/chart.umd.min.js','/preview-chart.js').replace(/<link rel="preconnect"[^>]+>/g,'').replace('<body>','<body><div class="preview-banner" role="status">โหมดทดลอง · ข้อมูลตัวอย่าง · ใช้ฟังก์ชันแอปจริงกับข้อมูลในหน่วยความจำ · โหลดใหม่เพื่อเริ่มต้น</div><style>.preview-banner{padding:10px 16px;text-align:center;background:#39305e;color:#f2edff;font:13px/1.6 system-ui}</style>');
      if(name==='css/styles.css')body=body.toString().replace(/^@import[^;]+;/,'');
    }
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'self'"});res.end(body);
  }catch{res.writeHead(404).end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`Aurora preview (synthetic data only): http://127.0.0.1:${port}`));
