'use strict';

const subscribers = new Map();

function normalizeAgentId(value) {
  return String(value == null ? '' : value).trim();
}

function subscribePrintAgentEvents(agentId, listener) {
  const id = normalizeAgentId(agentId);
  if (!id || typeof listener !== 'function') return () => {};

  let set = subscribers.get(id);
  if (!set) {
    set = new Set();
    subscribers.set(id, set);
  }
  set.add(listener);

  return () => {
    const current = subscribers.get(id);
    if (!current) return;
    current.delete(listener);
    if (!current.size) subscribers.delete(id);
  };
}

function publishPrintAgentEvent(agentId, eventName, payload = {}) {
  const id = normalizeAgentId(agentId);
  if (!id) return 0;
  const listeners = subscribers.get(id);
  if (!listeners?.size) return 0;

  let delivered = 0;
  for (const listener of [...listeners]) {
    try {
      listener({ eventName: String(eventName || 'message'), payload });
      delivered += 1;
    } catch (_) {
      listeners.delete(listener);
    }
  }
  if (!listeners.size) subscribers.delete(id);
  return delivered;
}

function notifyPrintJobAvailable(job) {
  if (!job?.targetAgentId) return 0;
  return publishPrintAgentEvent(job.targetAgentId, 'job_available', {
    jobId: String(job.jobId || ''),
  });
}

module.exports = {
  subscribePrintAgentEvents,
  publishPrintAgentEvent,
  notifyPrintJobAvailable,
};
