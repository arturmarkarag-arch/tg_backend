'use strict';

const { appError } = require('../../../utils/errors');

let validatorPromise = null;
async function loadValidator() {
  if (!validatorPromise) validatorPromise = import('@ksefuj/validator').catch((error) => { validatorPromise = null; throw error; });
  try { return await validatorPromise; } catch (error) { throw appError('ksef_xsd_validator_unavailable', { cause: String(error?.message || error).slice(0, 300) }); }
}
async function validateFa3Xml(xml) {
  const mod = await loadValidator();
  if (typeof mod.validate !== 'function') throw appError('ksef_xsd_validator_unavailable');
  const result = await mod.validate(String(xml), { locale: 'pl', enableXsdValidation: true, enableSemanticValidation: false });
  const errors = Array.isArray(result?.errors) ? result.errors.filter((entry) => entry?.source === 'xsd' || !entry?.source) : [];
  if (result?.valid !== true || errors.length) {
    throw appError('ksef_xsd_validation_failed', { errors: errors.slice(0, 50).map((entry) => ({ message: String(entry?.message || ''), path: String(entry?.path || ''), line: entry?.line ?? null })) });
  }
  return { valid: true, errors: [] };
}
module.exports = { validateFa3Xml };
