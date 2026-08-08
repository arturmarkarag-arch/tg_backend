const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('vitest');

const source = fs.readFileSync(path.join(__dirname, 'routes/deliveryGroups.js'), 'utf8');

describe('picking shop ordered-products disclosure contract', () => {
  it('stays lazy behind a dedicated staff endpoint and current session', () => {
    expect(source).toContain("/:groupId/shops/:shopId/ordered-products");
    expect(source).toContain("requireTelegramRoles(['admin', 'warehouse'])");
    expect(source).toContain('orderingSessionId: currentSessionId');
    expect(source).toContain("status: { $in: ['new', 'in_progress'] }");
  });

  it('matches shop-status counted positions and deduplicates products', () => {
    expect(source).toContain('item.cancelled || item.skipped');
    expect(source).toContain('if (seen.has(id)) continue');
    expect(source).toContain(".select('name brand model category imageUrls originalImageUrl localImageUrl orderNumber status')");
  });

  it('paginates the disclosure server-side in bounded chunks', () => {
    expect(source).toContain('req.query.limit');
    expect(source).toContain('req.query.offset');
    expect(source).toContain('.skip(offset)');
    expect(source).toContain('.limit(limit)');
    expect(source).toContain('hasMore: offset + products.length < total');
  });
});
