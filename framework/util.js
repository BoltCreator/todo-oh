'use strict';

const BackendApp = require('./BackendApp');

/**
 * Is method `m` genuinely implemented on `obj`? A function inherited unchanged
 * from the BackendApp base class is a no-op default and counts as NOT
 * implemented, so features only activate when the author actually provides them.
 */
const has = (obj, m) => {
  if (!obj || typeof obj[m] !== 'function') return false;
  if (BackendApp.prototype[m] && obj[m] === BackendApp.prototype[m]) return false;
  return true;
};


/**
 * Parse a human duration into milliseconds: parseDuration('2days'),
 * parseDuration('12hours'), parseDuration('30min'), parseDuration('90s'),
 * parseDuration(60000). Returns null when unparsable. Used by parameterized
 * apps (jsonList) so every app speaks the same duration format.
 */
const DUR_UNITS = {
  ms: 1, s: 1000, sec: 1000, second: 1000, seconds: 1000,
  min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, week: 604800000, weeks: 604800000,
  // A "month" is a fixed 30-day window (round schemes need fixed lengths).
  // Bare "m" stays unmapped on purpose — minutes vs months is too ambiguous.
  mo: 2592000000, month: 2592000000, months: 2592000000,
};
function parseDuration(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v !== 'string') return null;
  const m = v.trim().toLowerCase().match(/^([0-9]*\.?[0-9]+)\s*([a-z]*)$/);
  if (!m) return null;
  const unit = m[2] || 'ms';
  if (!(unit in DUR_UNITS)) return null;
  const ms = Math.floor(parseFloat(m[1]) * DUR_UNITS[unit]);
  return ms > 0 ? ms : null;
}

module.exports = { has, parseDuration };
