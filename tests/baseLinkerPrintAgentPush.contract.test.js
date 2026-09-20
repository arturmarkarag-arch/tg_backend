const fs = require('node:fs');
const path = require('node:path');
const { indexOrThrow } = require('./helpers/sourceContract');

describe('BaseLinker Print Agent push wake-up contract', () => {
  const root = path.join(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

  it('exposes an authenticated SSE stream for one agent', () => {
    const route = read('routes/baseLinkerPrintAgent.js');
    expect(route).toContain("router.get('/events'");
    expect(route).toContain("'Content-Type': 'text/event-stream; charset=utf-8'");
    expect(route).toContain("'Cache-Control': 'no-cache, no-transform'");
    expect(route).toContain("send({ eventName: 'ready', payload: { agentId } })");
    expect(route).toContain('subscribePrintAgentEvents(agentId, send)');
    expect(route).toContain('router.use(requireAgentToken)');
  });

  it('wakes the target agent only after a durable pending job exists', () => {
    const service = read('services/baseLinkerPrint.js');
    const createIndex = indexOrThrow(service, 'const job = await BaseLinkerPrintJob.create({', { label: 'durable print job create' });
    const notifyIndex = indexOrThrow(service, 'notifyPrintJobAvailable(queuedJob);', { from: createIndex, label: 'push wake-up' });
    expect(notifyIndex).toBeGreaterThan(createIndex);
    expect(service).toContain("if (existing.status === 'pending') notifyPrintJobAvailable(existing);");
  });

  it('keeps push delivery ephemeral while Mongo claim remains authoritative', () => {
    const events = read('services/baseLinkerPrintAgentEvents.js');
    const service = read('services/baseLinkerPrint.js');
    expect(events).toContain('const subscribers = new Map()');
    expect(events).toContain("publishPrintAgentEvent(job.targetAgentId, 'job_available'");
    expect(service).toContain('async function claimNextPrintJob');
    expect(service).toContain('findOneAndUpdate');
    expect(service).toContain("status: 'pending'");
    expect(service).toContain("status: 'claimed'");
  });
});
