'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('delivery-group batch presentation contract', () => {
  it('replaces per-group DB presentation with bounded batch reads', () => {
    const source = read('services/sessionPresentation.js');
    const block = sliceBetweenOrThrow(
      source,
      'async function getCurrentGroupPresentations',
      '/**\n * Lightweight current-group presentation for the group selector.',
      { label: 'batch delivery-group presentation' },
    );
    expect(block.match(/OrderingSession\.find\(/g)?.length || 0).toBe(1);
    expect(block.match(/Order\.aggregate\(/g)?.length || 0).toBe(1);
    expect(block.match(/PickingTask\.aggregate\(/g)?.length || 0).toBe(1);
    expect(block).not.toContain('findCurrentSessionId(');
    expect(block).not.toContain('groups.map((group) => getCurrentGroupPresentation');
  });

  it('catalog reads only distinct problematic group ids and one batch presentation', () => {
    const source = read('services/readModels/deliveryGroupCatalogReadModel.js');
    expect(source).toContain("Order.distinct('buyerSnapshot.deliveryGroupId'");
    expect(source).toContain('getCurrentGroupPresentations(groups, { now })');
    expect(source).not.toContain('ordersInClosedGroups');
  });
});
