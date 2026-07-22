'use strict';
// The bundled framework surface: everything a bundled app can require via
// require('../framework') or require('.../framework/<module>').
const points = require('./points');
module.exports = { BackendApp: require('./BackendApp'), compiler: require('./compiler'), Runner: require('./runner'), util: require('./util'), PointsService: points.PointsService, Ledger: points.Ledger };
