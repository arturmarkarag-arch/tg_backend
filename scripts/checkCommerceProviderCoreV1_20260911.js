'use strict';
const fs=require('fs'),path=require('path');const root=path.join(__dirname,'..');const read=r=>fs.readFileSync(path.join(root,r),'utf8');const checks=[];function check(n,f){try{f();checks.push([n,true])}catch(e){checks.push([n,false,e.message])}}function assert(v,m){if(!v)throw new Error(m)}
const contract=read('services/commerce/providers/contract.js'),preview=read('services/commerce/publicationPreview.js'),adapter=read('services/commerce/providers/allegro.js'),planned=read('services/commerce/providers/planned.js'),registry=read('services/commerce/providers/registry.js'),route=read('routes/commerce.js'),product=read('models/CommerceProduct.js'),doc=read('services/commerce/providers/README.md');
check('versioned provider contract',()=>{assert(contract.includes('PROVIDER_CONTRACT_VERSION = 1'),'version missing');for(const t of ["LISTING_PREVIEW: 'listing.preview'","LISTING_CREATE: 'listing.create'","PRICE_SYNC: 'listing.price.sync'","STOCK_SYNC: 'listing.stock.sync'"])assert(contract.includes(t),`${t} missing`)});
check('core preview delegates to adapters',()=>{for(const t of ['getProviderAdapter','adapter.preparePublicationPreview','adapter.previewPublicationRow','providerCalls: 0'])assert(preview.includes(t),`${t} missing`);for(const t of ["provider === 'allegro'","provider === 'olx'","provider === 'temu'"])assert(!preview.includes(t),`provider branch leaked: ${t}`)});
check('Allegro is first live adapter',()=>{for(const t of ["id: 'allegro'",'createProviderAdapter',"'draft.create'","'price.apply'","'stock.apply'","'lifecycle.apply'","'health.scan'"])assert(adapter.includes(t),`${t} missing`)});
check('planned adapters register independently',()=>{assert(registry.includes('[olx.id, olx]'),'OLX registration missing');assert(registry.includes('[temu.id, temu]'),'Temu registration missing');assert(planned.includes("id: 'olx'"),'OLX descriptor missing');assert(planned.includes("id: 'temu'"),'Temu descriptor missing')});
check('canonical product contains no provider fields',()=>assert(!/allegro|olx|temu/i.test(product),'provider field leaked into CommerceProduct'));
check('generic provider API surface',()=>{assert(route.includes("router.get('/providers'"),'providers registry route missing');assert(route.includes("router.post('/providers/:provider/operations/:operation'"),'generic operation route missing')});

check('provider runtime dependencies exist',()=>{
  const routeFile=path.join(root,'routes/commerce.js');
  const adapterFile=path.join(root,'services/commerce/providers/allegro.js');
  const routeSource=fs.readFileSync(routeFile,'utf8');
  const adapterSource=fs.readFileSync(adapterFile,'utf8');
  const missing=[];
  for(const match of routeSource.matchAll(/require\(['"](\.\.\/services\/commerce\/[^'"]+)['"]\)/g)){
    const resolved=path.resolve(path.dirname(routeFile),`${match[1]}.js`);
    if(!fs.existsSync(resolved)) missing.push(path.relative(root,resolved));
  }
  for(const match of adapterSource.matchAll(/lazy\(['"](\.\.\/[^'"]+)['"]/g)){
    const resolved=path.resolve(path.dirname(adapterFile),`${match[1]}.js`);
    if(!fs.existsSync(resolved)) missing.push(path.relative(root,resolved));
  }
  assert(missing.length===0,`missing runtime modules: ${missing.join(', ')}`);
});
check('architecture isolation documented',()=>{for(const t of ['Do not add provider fields to `CommerceProduct`','Product.quantity','providerData[provider]'])assert(doc.includes(t),`${t} missing`) });
for(const [n,ok,m] of checks)console.log(`${ok?'PASS':'FAIL'} ${n}${m?` — ${m}`:''}`);const failed=checks.filter(([,ok])=>!ok);console.log(`Commerce Provider Core v1: ${checks.length-failed.length}/${checks.length} PASS`);if(failed.length)process.exit(1);
