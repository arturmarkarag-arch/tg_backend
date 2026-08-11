const fs = require('fs');
const path = require('path');

describe('picking checkbox authorship contract', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('stores per-checkbox actor fields on PickingTask', () => {
    const model = read('models/PickingTask.js');
    expect(model).toContain('packedBy: { type: String');
    expect(model).toContain("packedByName: { type: String, default: '' }");
    expect(model).toContain('packedAt: { type: Date');
  });

  it('attributes only false -> true progress transitions and preserves prior authors', () => {
    const route = read('routes/picking.js');
    expect(route).toContain('const wasPacked = Boolean(plain.packed)');
    expect(route).toContain('if (shouldBePacked && !wasPacked)');
    expect(route).toContain("plain.packedByName = actor.byName || ''");
    expect(route).toContain('packedByName: item.packedByName');
  });

  it('keeps authorship correct on release/finalization fallback paths', () => {
    const service = read('services/pickingService.js');
    expect(service).toContain('const actorName = [userFirstName, userLastName].filter(Boolean).join');
    expect(service).toContain('if (shouldBePacked && !wasPacked)');
    expect(service).toContain('if (taskItem.packed && !wasPacked)');
    expect(service).toContain('if (shouldBePacked && !wasAlreadyPacked)');
  });
});
