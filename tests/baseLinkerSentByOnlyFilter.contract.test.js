const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('BaseLinker Sent worker filter contract', () => {
  it('keeps packed attribution as audit data but exposes only sentBy as the user filter', () => {
    const route = read('routes/baseLinker.js');
    const index = read('services/baseLinkerOrderIndex.js');
    const picking = read('services/baseLinkerPicking.js');

    expect(route).not.toContain('req.query.packedBy');
    expect(route).toContain('sentBy: req.query.sentBy');
    expect(index).not.toContain('packedByOptions');
    expect(index).not.toContain('activePackedBy');
    expect(index).not.toContain('safePackedBy');
    expect(index).toContain('sentByOptions');
    expect(index).toContain('safeSentBy');

    // Audit facts remain durable even though they are no longer a UI filter.
    expect(picking).toContain('doc.packedBy = actor.by');
    expect(picking).toContain('doc.packedAt = now');
  });
});
