const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('vitest');

const route = fs.readFileSync(path.join(__dirname, 'routes/deliveryGroups.js'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, 'services/readModels/currentSessionShopProductsReadModel.js'), 'utf8');

describe('picking shop ordered-products disclosure contract', () => {
  it('stays lazy behind a dedicated staff endpoint and current session', () => {
    expect(route).toContain("/:groupId/shops/:shopId/ordered-products");
    expect(route).toContain("requireTelegramRoles(['admin', 'warehouse'])");
    expect(route).toContain('buildCurrentSessionShopProductsReadModel({');
    expect(source).toContain('orderingSessionId: currentSessionId');
    expect(source).toContain("status: { $in: ['new', 'in_progress'] }");
  });

  it('matches shop-status counted positions and deduplicates products', () => {
    expect(source).toContain('if (!liveItem(item)) continue');
    expect(source).toContain('if (seen.has(id)) continue');
    expect(source).toContain(".select('name brand model category imageUrls originalImageUrl localImageUrl orderNumber status')");
  });

  it('paginates the disclosure server-side in bounded chunks', () => {
    expect(route).toContain('limit: req.query.limit');
    expect(route).toContain('offset: req.query.offset');
    expect(source).toContain('.skip(offset)');
    expect(source).toContain('.limit(limit)');
    expect(source).toContain('hasMore: offset + products.length < total');
  });
});
