'use strict';
// Offline Drive shim: no real Google Drive in a standalone bundle, so
// available() is false and save/load are graceful no-ops. Apps that gate on
// framework.drive.available(ctx) simply fall back to "not saved".
module.exports = { available: async () => false, save: async () => ({ saved: false, reason: 'no-drive' }), load: async () => null };
