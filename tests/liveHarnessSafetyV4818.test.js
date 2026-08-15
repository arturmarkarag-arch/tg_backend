'use strict';

const http = require('http');
const {
  validateScenarioSelection,
  fetchWithTimeout,
  createProgressWatchdog,
  waitForStableZero,
} = require('../scripts/helpers/liveHarnessSafety');

describe('V48.18 live harness safety helpers', () => {
  it('fails closed for empty or unknown scenario selections', () => {
    expect(() => validateScenarioSelection(new Set(), ['happy'])).toThrow(/at least one scenario/i);
    expect(() => validateScenarioSelection(new Set(['typo']), ['happy'])).toThrow(/unknown --scenario/i);
    expect(() => validateScenarioSelection(new Set(['happy']), ['happy'])).not.toThrow();
  });

  it('waits for a stable zero window instead of trusting one instant zero', async () => {
    const values = [2, 1, 0, 1, 0, 0, 0, 0, 0];
    let reads = 0;
    const result = await waitForStableZero(async () => ({ rows: values[Math.min(reads++, values.length - 1)] }), {
      timeoutMs: 500,
      quietMs: 35,
      intervalMs: 10,
      label: 'unit cleanup',
    });
    expect(result.rows).toBe(0);
    expect(reads).toBeGreaterThanOrEqual(6);
  });

  it('aborts a hung HTTP request with an explicit timeout code', async () => {
    const server = http.createServer((_req, res) => setTimeout(() => res.end('late'), 200));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      await expect(fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, { timeoutMs: 25, label: 'slow unit request' }))
        .rejects.toMatchObject({ code: 'LIVE_E2E_HTTP_TIMEOUT' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('watchdog exposes a dedicated stall error without requiring a hard process exit', async () => {
    const watchdog = createProgressWatchdog({ name: 'unit watchdog', stallMs: 30 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(watchdog.signal.aborted).toBe(true);
      expect(watchdog.signal.reason?.code).toBe('LIVE_E2E_STALLED');
      expect(() => watchdog.assertHealthy()).toThrow(/no progress/i);
    } finally {
      watchdog.stop();
    }
  });
});
