'use strict';

const fs = require('fs');
const path = require('path');
const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('completed session finalSummary retention contract', () => {
  it('stores frozen counters on OrderingSession before PickingTask retention can erase history', () => {
    const model = read('models/OrderingSession.js');
    const status = read('utils/sessionStatus.js');
    const presentation = read('services/sessionPresentation.js');

    expect(model).toContain('finalSummary: {');
    expect(model).toContain('finalizedAt:');
    expect(status).toContain("$set: { finalSummary: { ...summary, finalizedAt } }");
    expect(presentation).toContain('const frozen = target.finalSummary?.finalizedAt ? target.finalSummary : null');
    expect(presentation).toContain("'finalSummary.finalizedAt finalSummary.totalProductCount'");
    expect(presentation).toContain('hasWork = Number(sessionSummary.finalSummary.totalProductCount || 0) > 0');
  });

  it('invalidates the frozen summary when a completed session is explicitly reopened', () => {
    const status = read('utils/sessionStatus.js');
    expect(status).toContain('unset.finalSummary = 1');
  });
});
