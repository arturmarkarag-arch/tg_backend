const fs = require('node:fs');
const path = require('node:path');

describe('BaseLinker Print Agent contract', () => {
  const root = path.join(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

  it('keeps the agent on a separate token and never exposes the BaseLinker API token', () => {
    const route = read('routes/baseLinkerPrintAgent.js');
    const service = read('services/baseLinkerPrint.js');
    expect(route).toContain("x-print-agent-token");
    expect(route).toContain('BASELINKER_PRINT_AGENT_TOKEN');
    expect(route).not.toContain('BASELINKER_API_TOKEN');
    expect(service).not.toContain('BASELINKER_API_TOKEN');
  });

  it('queues locally and fetches getLabel only after the agent claims a job', () => {
    const service = read('services/baseLinkerPrint.js');
    expect(service).toContain('queuePrintJob');
    expect(service).toContain('claimNextPrintJob');
    expect(service).toContain('getPrintJobPayload');
    expect(service).toContain('fetchBaseLinkerLabel');
    const queueStart = service.indexOf('async function queuePrintJob');
    const payloadStart = service.indexOf('async function getPrintJobPayload');
    const labelCall = service.indexOf('await fetchBaseLinkerLabel', payloadStart);
    expect(queueStart).toBeGreaterThan(-1);
    expect(payloadStart).toBeGreaterThan(queueStart);
    expect(labelCall).toBeGreaterThan(payloadStart);
  });

  it('has durable job state, lease, expiry and a single atomic claim', () => {
    const model = read('models/BaseLinkerPrintJob.js');
    const service = read('services/baseLinkerPrint.js');
    expect(model).toContain("enum: ['pending', 'claimed', 'printing', 'succeeded', 'failed', 'expired']");
    expect(model).toContain('leaseUntil');
    expect(model).toContain('expiresAt');
    expect(service).toContain('findOneAndUpdate');
    expect(service).toContain("status: 'pending'");
    expect(service).toContain("status: 'claimed'");
  });

  it('mounts the agent endpoint outside Telegram auth but protects it with agent-token middleware', () => {
    const app = read('app.js');
    const route = read('routes/baseLinkerPrintAgent.js');
    expect(app).toContain("/^\\/api\\/print-agent(?:\\/.*)?$/");
    expect(app).toContain("app.use('/api/print-agent', baseLinkerPrintAgentRouter)");
    expect(route).toContain('router.use(requireAgentToken)');
  });

  it('keeps the user-facing print request inside the protected BaseLinker router', () => {
    const route = read('routes/baseLinker.js');
    expect(route).toContain("router.use(requireBaseLinkerPickingAccess)");
    expect(route).toContain("router.post('/packages/:packageId/print'");
  });
});
