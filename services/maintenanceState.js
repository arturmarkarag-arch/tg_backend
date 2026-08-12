'use strict';

const state = {
  active: false,
  since: null,
  issues: [],
};

function normalizeIssue(issue = {}) {
  return {
    key: String(issue.key || 'unknown_critical_failure'),
    title: String(issue.title || 'Критична перевірка не пройдена'),
    whatBroke: String(issue.whatBroke || 'Не вдалося підтвердити цілісність даних.'),
    technicalDetails: String(issue.technicalDetails || ''),
    howToFix: Array.isArray(issue.howToFix)
      ? issue.howToFix.map((step) => String(step))
      : [],
    docsPath: String(issue.docsPath || 'docs/operations/maintenance-mode.md'),
    detectedAt: new Date().toISOString(),
  };
}

function enterMaintenance(issue) {
  const normalized = normalizeIssue(issue);
  state.active = true;
  state.since ||= normalized.detectedAt;

  const index = state.issues.findIndex((item) => item.key === normalized.key);
  if (index >= 0) state.issues[index] = normalized;
  else state.issues.push(normalized);

}

function isMaintenanceActive() {
  return state.active;
}

function getMaintenanceState() {
  return {
    active: state.active,
    mode: state.active ? 'read_only' : 'normal',
    since: state.since,
    issues: state.issues.map((issue) => ({ ...issue })),
  };
}

function getPublicMaintenanceState() {
  return {
    active: state.active,
    mode: state.active ? 'read_only' : 'normal',
    since: state.since,
    issues: state.issues.map((issue) => ({
      key: issue.key,
      title: issue.title,
      whatBroke: issue.whatBroke,
      detectedAt: issue.detectedAt,
    })),
  };
}

function maintenanceReadOnlyMiddleware(req, res, next) {
  if (!state.active) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  // Read-only authentication/bootstrap operations remain available so staff can
  // enter the application and inspect the maintenance instructions.
  const readOnlyPosts = new Set([
    '/api/v1/telegram/validate',
    '/api/v1/telegram/me',
    '/api/v1/auth/google',
  ]);
  if (req.method === 'POST' && readOnlyPosts.has(req.path)) return next();

  return res.status(503).json({
    error: 'maintenance_read_only',
    message: 'Система працює в технічному режимі лише для перегляду. Запис заблоковано, доки не буде відновлено критичні індекси MongoDB.',
    maintenance: ['admin', 'warehouse'].includes(req.telegramUser?.role)
      ? getMaintenanceState()
      : getPublicMaintenanceState(),
  });
}

module.exports = {
  enterMaintenance,
  isMaintenanceActive,
  getMaintenanceState,
  getPublicMaintenanceState,
  maintenanceReadOnlyMiddleware,
};
