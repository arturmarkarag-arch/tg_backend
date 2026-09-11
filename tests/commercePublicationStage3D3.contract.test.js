'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.3 contract', () => {
  test('uses one minimal Allegro activation PATCH', () => {
    const service = read('services/commerce/allegroActivation.js');
    expect(service).toContain("body: { publication: { status: 'ACTIVE' } }");
    expect(service).toContain("retryPolicy: 'never'");
    expect(service).not.toContain('sellingMode: {');
  });

  test('final-gates current product and upstream offer before activation', () => {
    const service = read('services/commerce/allegroActivation.js');
    expect(service).toContain('previewPublication');
    expect(service).toContain('reconcileAllegroDraft');
    expect(service).toContain('compareSalesSettings');
    expect(service).toContain('readyForActivation !== true');
  });

  test('same command handles operation polling and ambiguity recovery', () => {
    const route = read('routes/commerce.js');
    const service = read('services/commerce/allegroActivation.js');
    expect(route).toContain("'/publications/allegro/activate'");
    expect(route).not.toContain("'/publications/allegro/activate/status'");
    expect(service).toContain('refreshPendingOperation');
    expect(service).toContain('recoverActivation');
    expect(service).toContain('retryUnknown');
  });
});
