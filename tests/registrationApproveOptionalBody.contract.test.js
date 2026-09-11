'use strict';

const fs = require('fs');
const path = require('path');

describe('registration approve optional body contract', () => {
  test('approve accepts a POST without a JSON body while keeping shopId override optional', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'v1', 'telegram.js'), 'utf8');

    expect(source).toContain("router.post('/register-requests/:id/approve'");
    expect(source).toContain('const overrideShopId = req.body?.shopId || null;');
    expect(source).not.toContain('const overrideShopId = req.body.shopId || null;');
  });
});
