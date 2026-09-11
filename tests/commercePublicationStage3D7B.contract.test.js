'use strict';
const fs=require('fs'), path=require('path');
const root=path.join(__dirname,'..'); const read=r=>fs.readFileSync(path.join(root,r),'utf8');
describe('Commerce Publication Stage 3D.7B contract',()=>{
  test('health is one read-only business endpoint',()=>{const r=read('routes/commerce.js'),s=read('services/commerce/allegroListingHealth.js');expect(r).toContain("'/publications/allegro/health'");expect(r).not.toContain("'/publications/allegro/health/status'");expect(s).toContain('/sale/product-offers/');expect(s).toContain("path: '/sale/offer-events'");expect(s).not.toContain("method: 'PATCH'");expect(s).not.toContain("method: 'PUT'");});
  test('health reconciles all commerce dimensions',()=>{const s=read('services/commerce/allegroListingHealth.js');for(const token of ['contentAndMappingHealth','salesSettingsHealth','effectivePrice','effectiveStock','lifecycleHealth','CommercePublicationJob'])expect(s).toContain(token);});
  test('main warehouse quantity is never health stock source',()=>{const s=read('services/commerce/allegroListingHealth.js');expect(s).not.toContain('Product.quantity');expect(s).toContain('getReservationTotals');});
  test('event journal is diagnostic best effort',()=>{const s=read('services/commerce/allegroListingHealth.js');expect(s).toContain("coverage: 'best_effort_last_24h'");});
  test('registry exposes final health',()=>{const r=read('services/commerce/integrationRegistry.js');expect(r).toContain("id: 'offers.health.read'");expect(r).toContain('Stage 3D.7B');});
});
