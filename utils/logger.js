/**
 * @file logger.js
 * @description Simple logging utility
 */

module.exports = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};
