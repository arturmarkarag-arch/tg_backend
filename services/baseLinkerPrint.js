const crypto = require('crypto');
const BaseLinkerPrintAgent = require('../models/BaseLinkerPrintAgent');
const BaseLinkerPrintJob = require('../models/BaseLinkerPrintJob');
const { fetchBaseLinkerLabel } = require('./baseLinkerShipments');
const { getIO } = require('../socket');
const { appError } = require('../utils/errors');

const AGENT_ONLINE_MS = Math.max(15_000, Number(process.env.BASELINKER_PRINT_AGENT_ONLINE_MS) || 35_000);
const JOB_EXPIRES_MS = Math.max(60_000, Number(process.env.BASELINKER_PRINT_JOB_EXPIRES_MS) || (10 * 60_000));
const JOB_LEASE_MS = Math.max(30_000, Number(process.env.BASELINKER_PRINT_JOB_LEASE_MS) || 90_000);
const DEDUPE_MS = Math.max(2_000, Number(process.env.BASELINKER_PRINT_JOB_DEDUPE_MS) || 15_000);

function text(value) {
  return String(value == null ? '' : value).trim();
}

function agentIdOf(value) {
  const valueText = text(value);
  if (!valueText || valueText.length > 96 || !/^[a-zA-Z0-9._:-]+$/.test(valueText)) {
    throw appError('baselinker_print_agent_id_invalid');
  }
  return valueText;
}

function printerNameOf(value) {
  const valueText = text(value);
  if (!valueText || valueText.length > 256) throw appError('baselinker_print_printer_invalid');
  return valueText;
}

function positiveInt(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw appError(code);
  return parsed;
}

function courierCodeOf(value) {
  const code = text(value);
  if (!code || code.length > 64) throw appError('baselinker_courier_code_invalid');
  return code;
}

function configured() {
  return Boolean(text(process.env.BASELINKER_PRINT_AGENT_TOKEN));
}

function publicAgent(agent) {
  if (!agent) return null;
  const plain = typeof agent.toObject === 'function' ? agent.toObject() : agent;
  const lastSeenAt = plain.lastSeenAt ? new Date(plain.lastSeenAt) : null;
  const online = Boolean(lastSeenAt && (Date.now() - lastSeenAt.getTime()) <= AGENT_ONLINE_MS);
  return {
    agentId: plain.agentId,
    printerName: plain.printerName || '',
    version: plain.version || '',
    capabilities: Array.isArray(plain.capabilities) ? plain.capabilities : [],
    lastSeenAt,
    online,
  };
}

async function getPrintAgentStatus() {
  const agents = configured()
    ? await BaseLinkerPrintAgent.find({}).sort({ lastSeenAt: -1 }).limit(20).lean()
    : [];
  const normalized = agents.map(publicAgent);
  return {
    configured: configured(),
    online: normalized.some((agent) => agent.online),
    agents: normalized,
    onlineWindowMs: AGENT_ONLINE_MS,
  };
}

async function heartbeatPrintAgent({ agentId, printerName, version, capabilities, ip }) {
  if (!configured()) throw appError('baselinker_print_agent_not_configured');
  const id = agentIdOf(agentId);
  const printer = printerNameOf(printerName);
  const safeCapabilities = [...new Set((Array.isArray(capabilities) ? capabilities : [])
    .map((value) => text(value).slice(0, 64))
    .filter(Boolean))].slice(0, 32);
  const now = new Date();

  const agent = await BaseLinkerPrintAgent.findOneAndUpdate(
    { agentId: id },
    {
      $set: {
        printerName: printer,
        version: text(version).slice(0, 64),
        capabilities: safeCapabilities,
        lastSeenAt: now,
        lastIp: text(ip).slice(0, 128),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  return publicAgent(agent);
}

async function chooseOnlineAgent() {
  if (!configured()) throw appError('baselinker_print_agent_not_configured');
  const cutoff = new Date(Date.now() - AGENT_ONLINE_MS);
  const agent = await BaseLinkerPrintAgent.findOne({ lastSeenAt: { $gte: cutoff } })
    .sort({ lastSeenAt: -1 })
    .lean();
  if (!agent) throw appError('baselinker_print_agent_offline');
  return agent;
}

function actorOf(user) {
  return {
    telegramId: text(user?.telegramId),
    name: text(user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.telegramId).slice(0, 160),
  };
}

function emitJob(job) {
  try {
    const io = getIO();
    if (!io || !job?.requestedByTelegramId) return;
    io.to(`user_${job.requestedByTelegramId}`).emit('baselinker_print_job_updated', {
      jobId: job.jobId,
      status: job.status,
      printerName: job.printerName || '',
      orderId: job.orderId || '',
      packageId: job.packageId,
      labelExtension: job.labelExtension || '',
      error: job.lastError || '',
      completedAt: job.completedAt || null,
    });
  } catch (_) {
    // Socket can be unavailable in tests/startup; printing state remains durable in Mongo.
  }
}

async function queuePrintJob({ orderId, packageId, courierCode, user }) {
  const id = positiveInt(packageId, 'baselinker_package_id_invalid');
  const code = courierCodeOf(courierCode);
  const actor = actorOf(user);
  if (!actor.telegramId) throw appError('auth_required');

  const agent = await chooseOnlineAgent();
  const dedupeCutoff = new Date(Date.now() - DEDUPE_MS);
  const existing = await BaseLinkerPrintJob.findOne({
    packageId: id,
    targetAgentId: agent.agentId,
    status: { $in: ['pending', 'claimed', 'printing'] },
    createdAt: { $gte: dedupeCutoff },
  }).sort({ createdAt: -1 }).lean();
  if (existing) {
    return {
      jobId: existing.jobId,
      status: existing.status,
      agentId: existing.targetAgentId,
      printerName: existing.printerName || agent.printerName || '',
      deduped: true,
    };
  }

  const now = new Date();
  const job = await BaseLinkerPrintJob.create({
    jobId: crypto.randomUUID(),
    orderId: text(orderId).slice(0, 64),
    packageId: id,
    courierCode: code,
    requestedByTelegramId: actor.telegramId,
    requestedByName: actor.name,
    targetAgentId: agent.agentId,
    printerName: agent.printerName || '',
    status: 'pending',
    expiresAt: new Date(now.getTime() + JOB_EXPIRES_MS),
  });
  emitJob(job.toObject());

  return {
    jobId: job.jobId,
    status: job.status,
    agentId: job.targetAgentId,
    printerName: job.printerName,
    deduped: false,
  };
}

async function expireOldJobs() {
  const now = new Date();
  const expired = await BaseLinkerPrintJob.find({
    status: { $in: ['pending', 'claimed', 'printing'] },
    expiresAt: { $lte: now },
  }).lean();
  if (!expired.length) return;
  await BaseLinkerPrintJob.updateMany(
    { _id: { $in: expired.map((job) => job._id) }, status: { $in: ['pending', 'claimed', 'printing'] } },
    { $set: { status: 'expired', completedAt: now, lastError: 'Завдання друку прострочено.' } },
  );
  for (const job of expired) emitJob({ ...job, status: 'expired', completedAt: now, lastError: 'Завдання друку прострочено.' });
}

async function releaseExpiredLeases(agentId) {
  const now = new Date();
  await BaseLinkerPrintJob.updateMany(
    {
      targetAgentId: agentId,
      status: { $in: ['claimed', 'printing'] },
      leaseUntil: { $lte: now },
      expiresAt: { $gt: now },
    },
    {
      $set: { status: 'pending', claimedAt: null, leaseUntil: null },
    },
  );
}

async function claimNextPrintJob({ agentId }) {
  const id = agentIdOf(agentId);
  await expireOldJobs();
  await releaseExpiredLeases(id);
  const now = new Date();
  const job = await BaseLinkerPrintJob.findOneAndUpdate(
    {
      targetAgentId: id,
      status: 'pending',
      expiresAt: { $gt: now },
    },
    {
      $set: {
        status: 'claimed',
        claimedAt: now,
        leaseUntil: new Date(now.getTime() + JOB_LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { createdAt: 1 } },
  ).lean();
  if (!job) return null;
  emitJob(job);
  return {
    jobId: job.jobId,
    orderId: job.orderId || '',
    packageId: job.packageId,
    courierCode: job.courierCode,
    printerName: job.printerName || '',
    attempts: job.attempts,
    expiresAt: job.expiresAt,
  };
}

async function getPrintJobPayload({ jobId, agentId }) {
  const id = agentIdOf(agentId);
  const job = await BaseLinkerPrintJob.findOne({ jobId: text(jobId), targetAgentId: id });
  if (!job) throw appError('baselinker_print_job_not_found');
  if (!['claimed', 'printing'].includes(job.status)) throw appError('baselinker_print_job_not_claimed');
  if (!job.expiresAt || job.expiresAt.getTime() <= Date.now()) throw appError('baselinker_print_job_expired');

  job.status = 'printing';
  job.leaseUntil = new Date(Date.now() + JOB_LEASE_MS);
  await job.save();
  emitJob(job.toObject());

  try {
    const label = await fetchBaseLinkerLabel({ packageId: job.packageId, courierCode: job.courierCode });
    job.labelExtension = label.extension;
    job.leaseUntil = new Date(Date.now() + JOB_LEASE_MS);
    await job.save();
    return { job: job.toObject(), label };
  } catch (error) {
    job.status = 'failed';
    job.lastError = text(error?.message || error).slice(0, 1000);
    job.completedAt = new Date();
    job.leaseUntil = null;
    await job.save();
    emitJob(job.toObject());
    throw error;
  }
}

async function completePrintJob({ jobId, agentId }) {
  const id = agentIdOf(agentId);
  const job = await BaseLinkerPrintJob.findOneAndUpdate(
    { jobId: text(jobId), targetAgentId: id, status: { $in: ['claimed', 'printing'] } },
    { $set: { status: 'succeeded', completedAt: new Date(), leaseUntil: null, lastError: '' } },
    { new: true },
  ).lean();
  if (!job) throw appError('baselinker_print_job_not_claimed');
  emitJob(job);
  return job;
}

async function failPrintJob({ jobId, agentId, error }) {
  const id = agentIdOf(agentId);
  const job = await BaseLinkerPrintJob.findOneAndUpdate(
    { jobId: text(jobId), targetAgentId: id, status: { $in: ['claimed', 'printing'] } },
    {
      $set: {
        status: 'failed',
        completedAt: new Date(),
        leaseUntil: null,
        lastError: text(error || 'Print failed').slice(0, 1000),
      },
    },
    { new: true },
  ).lean();
  if (!job) throw appError('baselinker_print_job_not_claimed');
  emitJob(job);
  return job;
}

module.exports = {
  configured,
  getPrintAgentStatus,
  heartbeatPrintAgent,
  queuePrintJob,
  claimNextPrintJob,
  getPrintJobPayload,
  completePrintJob,
  failPrintJob,
};
