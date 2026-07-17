'use strict';
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { compile } = require('./framework/compiler');
const Runner = require('./framework/runner');
const App = require('./app');

const STATE_FILE = path.join(__dirname, 'state.json');
const instance = new App({});
try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (typeof instance.read === 'function') instance.read(s); } catch (_) {}

let runner = null;
if (typeof instance.run === 'function') { runner = new Runner((dt) => instance.run(dt), 1000); runner.start(); }

const cfg = { basePath: '', getPath: '/__app/get', postPath: '/__app/post', statePath: '/__app/state', pollInterval: 1000 };
const expressApp = express();
expressApp.use(express.json({ limit: '1mb' }));
expressApp.get('/', (req, res) => res.type('html').send(compile(typeof instance.getHTML === 'function' ? instance.getHTML() : '<h1>App</h1>', cfg)));
expressApp.post('/__app/get', async (req, res) => { if (typeof instance.get !== 'function') return res.status(501).json({ ok: false }); try { const { query, params } = req.body || {}; res.json({ ok: true, result: await instance.get(query, params || {}, {}) }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
expressApp.post('/__app/post', async (req, res) => { if (typeof instance.post !== 'function') return res.status(501).json({ ok: false }); try { const { action, data } = req.body || {}; res.json({ ok: true, result: await instance.post(action, data || {}, {}) }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
expressApp.get('/__app/state', async (req, res) => res.json({ ok: true, result: typeof instance.getPublicState === 'function' ? await instance.getPublicState() : (typeof instance.getJson === 'function' ? instance.getJson() : {}) }));

function save() { if (typeof instance.getJson === 'function') { try { fs.writeFileSync(STATE_FILE, JSON.stringify(instance.getJson(), null, 2)); } catch (_) {} } }
const t = setInterval(save, 5000); if (t.unref) t.unref();
process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });

function start(port) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(port == null ? (Number(process.env.PORT) || 3000) : port, () => {
      const p = server.address().port;
      const url = 'http://localhost:' + p + '/';
      console.log("todo" + ' running at ' + url);
      resolve({ url, port: p, server });
    });
  });
}
if (require.main === module) start();
module.exports = { start, instance };
