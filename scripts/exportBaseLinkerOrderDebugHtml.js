'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

for (const envPath of [path.resolve(__dirname, '../../.env'), path.resolve(__dirname, '../.env')]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerAccount = require('../models/BaseLinkerAccount');
const BaseLinkerProductImageCache = require('../models/BaseLinkerProductImageCache');
const { makeBaseLinkerAccountCaller } = require('../services/baseLinkerClient');
const {
  catalogKeyForOrderProduct,
  fetchBaseLinkerProductCatalog,
} = require('../services/baseLinkerProducts');

const READ_METHODS = new Set([
  'getOrders',
  'getOrderPackages',
  'getPackageDetails',
  'getOrderPaymentsHistory',
  'getOrderSources',
  'getOrderStatusList',
  'getInventories',
  'getExternalStoragesList',
  'getInventoryProductsList',
  'getInventoryProductsData',
  'getProductsList',
  'getProductsData',
]);

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function htmlDocument(report) {
  const embedded = jsonForScript(report);
  return `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BaseLinker order ${report.orderId} — повний debug</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --card:#121a2e; --soft:#1a2540; --line:#2b395d; --text:#eef3ff; --muted:#9eabd0; --accent:#68a7ff; --good:#58d68d; --bad:#ff7f8f; }
    * { box-sizing:border-box; }
    body { margin:0; background:linear-gradient(135deg,#080c18,#101934 65%,#111a2a); color:var(--text); font:14px/1.5 Inter,Segoe UI,Arial,sans-serif; }
    main { width:min(1500px,calc(100% - 32px)); margin:24px auto 80px; }
    h1 { font-size:28px; margin:0 0 4px; } h2 { font-size:19px; margin:0; } h3 { font-size:15px; margin:0; }
    a { color:#8ec2ff; overflow-wrap:anywhere; }
    .muted { color:var(--muted); }
    .banner { border:1px solid #694754; background:#291923; color:#ffd7dd; padding:12px 16px; border-radius:12px; margin:18px 0; }
    .toolbar { position:sticky; top:0; z-index:10; display:flex; gap:10px; flex-wrap:wrap; padding:12px; margin:16px 0; border:1px solid var(--line); border-radius:14px; background:rgba(11,16,32,.94); backdrop-filter:blur(10px); }
    input { flex:1; min-width:260px; background:#080d1b; color:var(--text); border:1px solid var(--line); border-radius:9px; padding:10px 12px; }
    button { background:#22375f; color:white; border:1px solid #3c5d98; border-radius:9px; padding:9px 13px; cursor:pointer; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px; margin:16px 0; }
    .stat,.section { background:rgba(18,26,46,.96); border:1px solid var(--line); border-radius:14px; }
    .stat { padding:14px; } .stat b { display:block; font-size:22px; margin-top:3px; }
    .section { margin:14px 0; overflow:hidden; }
    .section > header { padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); }
    .section > .body { padding:14px 16px; }
    .photos { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:14px; }
    .photo { background:#090f20; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
    .photo img { width:100%; height:220px; object-fit:contain; display:block; background:#060914; }
    .photo .meta { padding:10px; word-break:break-word; }
    .url { padding:9px 0; border-bottom:1px dashed #293654; } .url:last-child { border:0; }
    details { border-left:1px solid #334265; margin:4px 0 4px 10px; padding-left:10px; }
    summary { cursor:pointer; color:#caddff; padding:3px 0; }
    .primitive { display:grid; grid-template-columns:minmax(160px,280px) 1fr; gap:10px; padding:4px 0; border-bottom:1px dotted #25324e; }
    .key { color:#92a8d7; overflow-wrap:anywhere; } .value { white-space:pre-wrap; overflow-wrap:anywhere; }
    .null { color:#7785a8; font-style:italic; }
    .tag { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:999px; background:#263859; color:#dbe8ff; font-size:12px; }
    .good { color:var(--good); } .bad { color:var(--bad); }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; font:12px/1.5 Consolas,monospace; }
    .hidden-by-search { display:none !important; }
  </style>
</head>
<body>
<main>
  <h1>Замовлення №${report.orderId}</h1>
  <div class="muted">Повний read-only знімок BaseLinker + локальної БД · ${report.generatedAt}</div>
  <div class="banner">У файлі є персональні дані покупця та адреса. Не публікуй цей HTML і не пересилай стороннім.</div>
  <div class="toolbar">
    <input id="search" placeholder="Пошук по будь-якому ключу, ID, URL або значенню…">
    <button id="expand">Розкрити все</button><button id="collapse">Згорнути все</button><button id="copy">Копіювати весь JSON</button>
  </div>
  <div id="stats" class="grid"></div>
  <section class="section"><header><h2>Усі знайдені фото</h2><span id="photoCount" class="tag"></span></header><div class="body"><div id="photos" class="photos"></div></div></section>
  <section class="section"><header><h2>Усі URL без винятку</h2><span id="urlCount" class="tag"></span></header><div id="urls" class="body"></div></section>
  <div id="sections"></div>
</main>
<script>
const DATA=${embedded};
const esc=(v)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const urlRx=/https?:\\/\\/[^\\s"'<>]+/gi;
function valueHtml(v){
  if(v===null||v===undefined)return '<span class="null">'+String(v)+'</span>';
  const s=String(v); const matches=s.match(urlRx);
  if(matches&&matches.length===1&&matches[0]===s)return '<a href="'+esc(s)+'" target="_blank" rel="noreferrer">'+esc(s)+'</a>';
  return '<span class="value">'+esc(s)+'</span>';
}
function tree(value,label='root',depth=0){
  if(value===null||typeof value!=='object')return '<div class="primitive searchable"><span class="key">'+esc(label)+'</span>'+valueHtml(value)+'</div>';
  const entries=Array.isArray(value)?value.map((v,i)=>[i,v]):Object.entries(value);
  const summary=esc(label)+' <span class="muted">'+(Array.isArray(value)?'['+entries.length+']':'{'+entries.length+'}')+'</span>';
  return '<details '+(depth<1?'open':'')+' class="searchable"><summary>'+summary+'</summary>'+entries.map(([k,v])=>tree(v,k,depth+1)).join('')+'</details>';
}
function collect(value,path=[],out={urls:[],photos:[]}){
  if(value===null||value===undefined)return out;
  if(typeof value==='object'){
    for(const [k,v] of Object.entries(value))collect(v,path.concat(k),out);
    return out;
  }
  if(typeof value!=='string')return out;
  const urls=value.match(urlRx)||[];
  for(const url of urls){
    out.urls.push({url,path:path.join('.')});
    const key=path.join('.').toLowerCase();
    if(/image|photo|picture|thumbnail|avatar|logo/.test(key)||/\\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(url))out.photos.push({url,path:path.join('.')});
  }
  return out;
}
const found=collect(DATA);
const uniq=(rows)=>[...new Map(rows.map(x=>[x.url,x])).values()];
const urls=uniq(found.urls), photos=uniq(found.photos);
const rawOrder=DATA.baseLinker?.getOrders?.orders?.[0]||{};
const products=rawOrder.products||[];
document.getElementById('stats').innerHTML=[
  ['Акаунт',DATA.account?.name||DATA.accountId],['Джерело',(rawOrder.order_source||'—')+' / '+(rawOrder.order_source_id||'—')],
  ['Товарних рядків',products.length],['URL знайдено',urls.length],['Фото знайдено',photos.length],['Resolver',DATA.productResolution?.stats?.resolved+' / '+DATA.productResolution?.stats?.requested]
].map(([k,v])=>'<div class="stat searchable"><span class="muted">'+esc(k)+'</span><b>'+esc(v)+'</b></div>').join('');
document.getElementById('photoCount').textContent=photos.length;
document.getElementById('photos').innerHTML=photos.length?photos.map(x=>'<article class="photo searchable"><a href="'+esc(x.url)+'" target="_blank" rel="noreferrer"><img loading="lazy" src="'+esc(x.url)+'" alt="'+esc(x.path)+'" onerror="this.style.opacity=.25"></a><div class="meta"><div class="muted">'+esc(x.path)+'</div><a href="'+esc(x.url)+'" target="_blank" rel="noreferrer">'+esc(x.url)+'</a></div></article>').join(''):'<div class="bad">Жодного URL фотографії у доступних відповідях немає.</div>';
document.getElementById('urlCount').textContent=urls.length;
document.getElementById('urls').innerHTML=urls.length?urls.map(x=>'<div class="url searchable"><div class="muted">'+esc(x.path)+'</div><a href="'+esc(x.url)+'" target="_blank" rel="noreferrer">'+esc(x.url)+'</a></div>').join(''):'<div class="muted">URL не знайдено</div>';
const sectionOrder=['derivedLinks','baseLinker','productResolution','database','account'];
document.getElementById('sections').innerHTML=sectionOrder.filter(k=>k in DATA).map(k=>'<section class="section searchable"><header><h2>'+esc(k)+'</h2></header><div class="body">'+tree(DATA[k],k)+'</div></section>').join('');
document.getElementById('expand').onclick=()=>document.querySelectorAll('details').forEach(x=>x.open=true);
document.getElementById('collapse').onclick=()=>document.querySelectorAll('details').forEach(x=>x.open=false);
document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(JSON.stringify(DATA,null,2));document.getElementById('copy').textContent='Скопійовано';};
document.getElementById('search').oninput=(e)=>{const q=e.target.value.trim().toLowerCase();document.querySelectorAll('.searchable').forEach(x=>x.classList.toggle('hidden-by-search',q&&!x.textContent.toLowerCase().includes(q)));};
</script>
</body>
</html>`;
}

async function optional(callApi, method, parameters) {
  try {
    return await callApi(method, parameters);
  } catch (error) {
    return { status: 'ERROR', error_code: error?.code || 'request_failed', error_message: error?.message || String(error) };
  }
}

async function main() {
  const orderId = Number(arg('order', '72198361'));
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('--order must be a positive integer');
  if (!clean(process.env.MONGODB_URI)) throw new Error('MONGODB_URI is required');
  if (!clean(process.env.BASELINKER_TOKEN_ENCRYPTION_KEY)) throw new Error('BASELINKER_TOKEN_ENCRYPTION_KEY is required');

  await mongoose.connect(process.env.MONGODB_URI, {
    autoCreate: false,
    autoIndex: false,
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 20_000,
    socketTimeoutMS: 120_000,
  });

  const indexCandidates = await BaseLinkerOrderIndex.find({ orderId: String(orderId) }).lean();
  const requestedAccountId = clean(arg('account'));
  const accountId = requestedAccountId || clean(indexCandidates[0]?.baseLinkerAccountId);
  if (!accountId) throw new Error(`Order ${orderId} was not found in the local BaseLinker index; pass --account=<uuid>`);

  const account = await BaseLinkerAccount.findOne({ accountId }).select('-tokenEncrypted -tokenFingerprint').lean();
  if (!account) throw new Error(`BaseLinker account ${accountId} was not found`);

  const upstream = makeBaseLinkerAccountCaller(accountId, { usageStage: 'order_debug_html_read_only' });
  const calls = [];
  const callApi = async (method, parameters = {}) => {
    if (!READ_METHODS.has(method)) throw new Error(`SAFETY BLOCK: ${method}`);
    const startedAt = new Date().toISOString();
    try {
      const response = await upstream(method, parameters);
      calls.push({ method, parameters, startedAt, status: response?.status || 'SUCCESS' });
      return response;
    } catch (error) {
      calls.push({ method, parameters, startedAt, status: 'ERROR', error_code: error?.code || '', error_message: error?.message || String(error) });
      throw error;
    }
  };

  const getOrders = await callApi('getOrders', {
    order_id: orderId,
    get_unconfirmed_orders: true,
    include_custom_extra_fields: true,
    include_commissions: true,
    include_connect_data: true,
  });
  const rawOrder = (Array.isArray(getOrders?.orders) ? getOrders.orders : []).find((row) => Number(row?.order_id) === orderId);
  if (!rawOrder) throw new Error(`BaseLinker getOrders did not return order ${orderId}`);

  const [packages, payments, sources, statuses, inventories, externalStorages, pickingDoc] = await Promise.all([
    optional(callApi, 'getOrderPackages', { order_id: orderId }),
    optional(callApi, 'getOrderPaymentsHistory', { order_id: orderId, show_full_history: true }),
    optional(callApi, 'getOrderSources', {}),
    optional(callApi, 'getOrderStatusList', {}),
    optional(callApi, 'getInventories', {}),
    optional(callApi, 'getExternalStoragesList', {}),
    BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: String(orderId) }).lean(),
  ]);

  const packageDetails = [];
  for (const item of Array.isArray(packages?.packages) ? packages.packages : []) {
    if (item?.package_id) packageDetails.push(await optional(callApi, 'getPackageDetails', { package_id: item.package_id }));
  }

  const annotatedOrder = { ...rawOrder, baseLinkerAccountId: accountId };
  const productResolution = await fetchBaseLinkerProductCatalog([annotatedOrder], callApi);
  const productKeys = (Array.isArray(rawOrder.products) ? rawOrder.products : []).map((product) => ({
    order_product_id: product?.order_product_id,
    product_id: product?.product_id,
    auction_id: product?.auction_id,
    key: catalogKeyForOrderProduct(product, accountId, rawOrder.order_source, orderId),
  }));
  const cacheRows = await BaseLinkerProductImageCache.find({ productKey: { $in: productKeys.map((row) => row.key).filter(Boolean) } }).lean();

  const derivedLinks = {
    baseLinkerPanelOrder: `https://panel.baselinker.com/orders.php#order:${orderId}`,
    orderPageFromApi: clean(rawOrder.order_page) || null,
    marketplaceOffers: productKeys
      .filter((row) => /^\d{5,30}$/.test(clean(row.auction_id)) && clean(rawOrder.order_source).toLowerCase() === 'allegro')
      .map((row) => ({ auction_id: clean(row.auction_id), url: `https://allegro.pl/oferta/${clean(row.auction_id)}` })),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    orderId,
    accountId,
    derivedLinks,
    baseLinker: {
      getOrders,
      getOrderPackages: packages,
      getPackageDetails: packageDetails,
      getOrderPaymentsHistory: payments,
      getOrderSources: sources,
      getOrderStatusList: statuses,
      getInventories: inventories,
      getExternalStoragesList: externalStorages,
      readOnlyCallLog: calls,
    },
    productResolution: {
      keys: productKeys,
      catalog: productResolution.productCatalog,
      stats: productResolution.productCatalogStats,
      warnings: productResolution.productCatalogWarnings,
    },
    database: {
      orderIndexCandidates: indexCandidates,
      pickingOrder: pickingDoc,
      productImageCache: cacheRows,
    },
    account,
  };

  const defaultOutput = path.resolve(__dirname, '../../.dev-tools', `baselinker-order-${orderId}.html`);
  const output = path.resolve(arg('output', defaultOutput));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, htmlDocument(report), 'utf8');
  console.log(JSON.stringify({
    output,
    orderId,
    account: account.name,
    source: `${rawOrder.order_source}|${rawOrder.order_source_id}`,
    products: Array.isArray(rawOrder.products) ? rawOrder.products.length : 0,
    resolvedProducts: productResolution.productCatalogStats?.resolved || 0,
    baseLinkerReadCalls: calls.length,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.connection.close(false); } catch (_) { /* ignore */ }
    process.exit(process.exitCode || 0);
  });
