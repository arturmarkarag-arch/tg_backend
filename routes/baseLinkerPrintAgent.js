const crypto = require('crypto');
const express = require('express');
const { asyncHandler } = require('../utils/errors');
const {
  heartbeatPrintAgent,
  claimNextPrintJob,
  getPrintJobPayload,
  completePrintJob,
  failPrintJob,
} = require('../services/baseLinkerPrint');

const router = express.Router();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAgentToken(req, res, next) {
  const expected = String(process.env.BASELINKER_PRINT_AGENT_TOKEN || '').trim();
  const actual = String(req.get('x-print-agent-token') || '').trim();
  if (!expected) return res.status(503).json({ error: 'baselinker_print_agent_not_configured', message: 'Print Agent не налаштовано на сервері.' });
  if (!safeEqual(actual, expected)) return res.status(401).json({ error: 'print_agent_unauthorized', message: 'Невірний Print Agent token.' });
  return next();
}

router.use(requireAgentToken);

router.post('/heartbeat', asyncHandler(async (req, res) => {
  const agent = await heartbeatPrintAgent({
    agentId: req.body?.agentId,
    printerName: req.body?.printerName,
    version: req.body?.version,
    capabilities: req.body?.capabilities,
    ip: req.ip || req.socket?.remoteAddress || '',
  });
  res.json({ ok: true, agent });
}));

router.post('/jobs/claim', asyncHandler(async (req, res) => {
  const job = await claimNextPrintJob({ agentId: req.body?.agentId });
  if (!job) return res.status(204).end();
  return res.json({ job });
}));

router.get('/jobs/:jobId/payload', asyncHandler(async (req, res) => {
  const { job, label } = await getPrintJobPayload({
    jobId: req.params.jobId,
    agentId: req.query.agentId,
  });
  const extension = /^[a-z0-9]{1,8}$/.test(label.extension) ? label.extension : 'bin';
  res.set({
    'Content-Type': label.contentType,
    'Content-Length': String(label.buffer.length),
    'Content-Disposition': `attachment; filename="baselinker-print-${job.jobId}.${extension}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Print-Job-Id': job.jobId,
    'X-Print-Job-Extension': extension,
    'X-Print-Printer-Name': encodeURIComponent(job.printerName || ''),
  });
  res.send(label.buffer);
}));

router.post('/jobs/:jobId/complete', asyncHandler(async (req, res) => {
  await completePrintJob({ jobId: req.params.jobId, agentId: req.body?.agentId });
  res.json({ ok: true });
}));

router.post('/jobs/:jobId/fail', asyncHandler(async (req, res) => {
  await failPrintJob({
    jobId: req.params.jobId,
    agentId: req.body?.agentId,
    error: req.body?.error,
  });
  res.json({ ok: true });
}));

module.exports = router;
