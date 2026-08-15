const fs = require('node:fs');
const path = require('node:path');
const {
  deriveSessionPresentationMode,
  isUpcomingPreflightWindow,
} = require('../services/sessionPresentation');

const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
const { indexOrThrow, sliceBetweenOrThrow } = require('./helpers/sourceContract');

describe('picking upcoming-session readiness contract', () => {
  it('treats completed AND empty/idle terminal cycles as readiness candidates', () => {
    const next = new Date('2026-08-12T14:30:00.000Z'); // 16:30 Europe/Warsaw in August
    const within24h = new Date(next.getTime() - 23 * 60 * 60 * 1000);

    expect(isUpcomingPreflightWindow(next, within24h)).toBe(true);
    expect(deriveSessionPresentationMode({ phase: 'completed', nextOrderingOpenAt: next, now: within24h }))
      .toBe('upcoming_preflight');
    expect(deriveSessionPresentationMode({ phase: 'idle', nextOrderingOpenAt: next, now: within24h }))
      .toBe('upcoming_preflight');
  });

  it('uses exact 24h boundaries and stops preflight at the ordering-open instant', () => {
    const nextMs = new Date('2026-08-12T14:30:00.000Z').getTime();
    expect(isUpcomingPreflightWindow(new Date(nextMs), new Date(nextMs - 24 * 60 * 60 * 1000))).toBe(true);
    expect(isUpcomingPreflightWindow(new Date(nextMs), new Date(nextMs - 24 * 60 * 60 * 1000 - 1))).toBe(false);
    expect(isUpcomingPreflightWindow(new Date(nextMs), new Date(nextMs))).toBe(false);
  });

  it('never hides live work behind the upcoming readiness screen', () => {
    const next = new Date('2026-08-12T14:30:00.000Z');
    const within24h = new Date(next.getTime() - 60 * 60 * 1000);

    expect(deriveSessionPresentationMode({ phase: 'awaiting_picking', nextOrderingOpenAt: next, now: within24h }))
      .toBe('awaiting_picking');
    expect(deriveSessionPresentationMode({ phase: 'picking', nextOrderingOpenAt: next, now: within24h }))
      .toBe('picking');
    expect(deriveSessionPresentationMode({ phase: 'ordering_open', nextOrderingOpenAt: next, now: within24h }))
      .toBe('ordering_open');
  });

  it('publishes one server-authoritative presentation mode in group list and picking reads', () => {
    const groups = read('routes/deliveryGroups.js');
    const picking = read('routes/picking.js');

    expect(groups).toContain('presentationMode: presentations[index]?.presentationMode');
    expect(groups).toContain('nextOrderingOpenAt: presentations[index]?.nextOrderingOpenAt');
    expect(picking).toContain("if (presentationMode === 'upcoming_preflight')");
    expect(picking).toContain('upcomingPreflight: true');
    expect(picking).toContain('presentationMode, nextOrderingOpenAt, windowOpen, windowCloseAt, windowMessage');
  });

  it('checks readiness before any session-creating or lock-mutating operation', () => {
    const source = read('routes/picking.js');
    const preflight = indexOrThrow(source, "if (presentationMode === 'upcoming_preflight')");
    const mutate = indexOrThrow(source, 'await releaseWorkerAndStaleLocks', { from: preflight });
    const create = indexOrThrow(source, 'await getOrCreateSessionId', { from: preflight });
    expect(mutate).toBeGreaterThan(preflight);
    expect(create).toBeGreaterThan(preflight);
  });

  it('readiness shop view remains assignment-only and does not materialise a future OrderingSession', () => {
    const source = read('routes/deliveryGroups.js');
    const readinessBranch = sliceBetweenOrThrow(source, "const readinessOnly = req.query.view === 'readiness'", 'const currentSessionId = await findCurrentSessionId', { label: 'readiness-only shop view' });

    expect(readinessBranch).toContain("view: 'readiness'");
    expect(readinessBranch).toContain('currentSessionId: null');
    expect(readinessBranch).toContain('hasMultipleSellers: assignedStaff.length > 1');
    expect(readinessBranch).not.toContain('getOrCreateSessionId(');
    expect(readinessBranch).not.toContain('CatalogReview.find(');
    expect(readinessBranch).not.toContain('Order.find(');
  });
});
