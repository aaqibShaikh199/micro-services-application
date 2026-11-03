const express = require('express');
const client = require('prom-client');
const path = require('path');

const { version } = require('./package.json');

const SERVICE_NAME = 'eyes';
const PORT = Number(process.env.PORT || 3004);
const TRACK = process.env.ROBOT_TRACK || 'v1';
const STOMACH_URL = process.env.STOMACH_URL || 'http://127.0.0.1:3003';
const HEAD_URL = process.env.HEAD_URL || 'http://127.0.0.1:3005';
const REQUIRE_ENERGY = process.env.REQUIRE_ENERGY === 'true';

const SCENES = {
  lab: [
    { name: 'workbench', confidence: 0.96 },
    { name: 'soldering iron', confidence: 0.91 },
    { name: 'cable spool', confidence: 0.88 },
  ],
  warehouse: [
    { name: 'crate', confidence: 0.98 },
    { name: 'pallet jack', confidence: 0.9 },
    { name: 'warning stripe', confidence: 0.84 },
  ],
  outdoor: [
    { name: 'oak tree', confidence: 0.93 },
    { name: 'survey drone', confidence: 0.8 },
    { name: 'rock', confidence: 0.99 },
  ],
};

const register = new client.Registry();
client.collectDefaultMetrics({ register, labels: { service: SERVICE_NAME } });

const httpRequests = new client.Counter({
  name: 'robot_http_requests_total',
  help: 'HTTP requests handled by this microservice',
  labelNames: ['service', 'method', 'route', 'status'],
  registers: [register],
});

const actionCounter = new client.Counter({
  name: 'robot_part_actions_total',
  help: 'Body-part actions accepted or rejected',
  labelNames: ['service', 'action', 'result'],
  registers: [register],
});

const upstreamCalls = new client.Counter({
  name: 'robot_upstream_calls_total',
  help: 'Calls from this service to another robot service',
  labelNames: ['service', 'target', 'result'],
  registers: [register],
});

new client.Gauge({
  name: 'robot_build_info',
  help: 'Static build labels for this process',
  labelNames: ['service', 'version', 'track'],
  registers: [register],
}).set({ service: SERVICE_NAME, version, track: TRACK }, 1);

const startedAt = new Date().toISOString();
const state = {
  mode: 'idle',
  focus: null,
  scene: null,
  identified: [],
  lastAction: 'boot',
  updatedAt: startedAt,
};

let shuttingDown = false;
let powerCache = { at: 0, value: { link: 'unknown' } };

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    msg,
    ...extra,
  }));
}

function links() {
  return {
    legs: process.env.PUBLIC_LEGS_URL || 'http://127.0.0.1:3001',
    hands: process.env.PUBLIC_HANDS_URL || 'http://127.0.0.1:3002',
    stomach: process.env.PUBLIC_STOMACH_URL || 'http://127.0.0.1:3003',
    eyes: process.env.PUBLIC_EYES_URL || 'http://127.0.0.1:3004',
    head: process.env.PUBLIC_HEAD_URL || 'http://127.0.0.1:3005',
  };
}

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function requestJson(url, { method = 'GET', body, timeoutMs = 2000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-robot-caller': SERVICE_NAME,
        'x-robot-track': TRACK,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    const wrapped = new Error(timedOut ? `timed out calling ${url}` : `could not reach ${url}`);
    wrapped.status = timedOut ? 504 : 503;
    throw wrapped;
  }

  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const wrapped = new Error(payload.error || `upstream status ${response.status}`);
    wrapped.status = response.status;
    wrapped.payload = payload;
    throw wrapped;
  }
  return payload;
}

function touch(action) {
  state.lastAction = action;
  state.updatedAt = new Date().toISOString();
}

async function spendEnergy(amount, reason) {
  if (amount <= 0) return { skipped: true };
  try {
    const result = await requestJson(`${STOMACH_URL}/api/energy/consume`, {
      method: 'POST',
      body: { amount, consumer: SERVICE_NAME, reason },
      timeoutMs: 1500,
    });
    upstreamCalls.inc({ service: SERVICE_NAME, target: 'stomach', result: 'ok' });
    const value = { link: 'up', level: result.energy, diamond: result.diamond };
    powerCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    upstreamCalls.inc({ service: SERVICE_NAME, target: 'stomach', result: 'error' });
    if (error.status === 409 || REQUIRE_ENERGY) throw error;
    return { link: 'down', warning: error.message };
  }
}

function reportToHead(payload) {
  requestJson(`${HEAD_URL}/api/observations`, {
    method: 'POST',
    body: payload,
    timeoutMs: 800,
  }).then(() => {
    upstreamCalls.inc({ service: SERVICE_NAME, target: 'head', result: 'ok' });
  }).catch((error) => {
    upstreamCalls.inc({ service: SERVICE_NAME, target: 'head', result: 'error' });
    log('warn', 'head did not accept observation', { error: error.message });
  });
}

async function readPower() {
  if (Date.now() - powerCache.at < 1500) return powerCache.value;
  try {
    const data = await requestJson(`${STOMACH_URL}/api/energy`, { timeoutMs: 800 });
    powerCache = {
      at: Date.now(),
      value: { link: 'up', level: data.energy, diamond: data.diamond },
    };
  } catch (error) {
    powerCache = { at: Date.now(), value: { link: 'down', error: error.message } };
  }
  return powerCache.value;
}

function publicState(power) {
  return {
    service: SERVICE_NAME,
    part: 'eyes',
    version,
    track: TRACK,
    mode: state.mode,
    focus: state.focus,
    scene: state.scene,
    identified: state.identified,
    lastAction: state.lastAction,
    updatedAt: state.updatedAt,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    power: power && power.link ? power : powerCache.value,
  };
}

function sendError(res, error, action) {
  actionCounter.inc({ service: SERVICE_NAME, action: action || 'unknown', result: 'error' });
  const status = Number.isInteger(error.status) ? error.status : 502;
  res.status(status).json({
    error: error.message,
    service: SERVICE_NAME,
    upstream: error.payload || null,
  });
}

const PART_URLS = {
  legs: process.env.LEGS_URL || 'http://127.0.0.1:3001',
  hands: process.env.HANDS_URL || 'http://127.0.0.1:3002',
  stomach: process.env.STOMACH_URL || 'http://127.0.0.1:3003',
  eyes: process.env.EYES_URL || 'http://127.0.0.1:3004',
  head: process.env.HEAD_URL || 'http://127.0.0.1:3005',
};

async function probePart(name, base) {
  if (name === SERVICE_NAME) return { ok: !shuttingDown };
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(800) });
    return { ok: response.ok };
  } catch (error) {
    return { ok: false };
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Robot-Service', SERVICE_NAME);
  res.set('X-Robot-Track', TRACK);
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Robot-Caller');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  res.on('finish', () => {
    const route = req.route && req.route.path ? req.route.path : req.path;
    httpRequests.inc({
      service: SERVICE_NAME,
      method: req.method,
      route: String(route),
      status: String(res.statusCode),
    });
  });
  return next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: SERVICE_NAME });
});

app.get('/ready', (req, res) => {
  if (shuttingDown) return res.status(503).json({ ready: false, service: SERVICE_NAME });
  return res.json({ ready: true, service: SERVICE_NAME });
});

app.get('/metrics', asyncRoute(async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}));

app.get('/api/status', asyncRoute(async (req, res) => {
  res.json(publicState(await readPower()));
}));

app.get('/api/ui-config', (req, res) => {
  res.json({ service: SERVICE_NAME, track: TRACK, links: links() });
});

app.get('/api/parts-health', asyncRoute(async (req, res) => {
  const entries = await Promise.all(Object.entries(PART_URLS).map(async ([name, base]) => {
    return [name, await probePart(name, base)];
  }));
  res.set('Cache-Control', 'no-store');
  res.json({
    parts: Object.fromEntries(entries),
    checkedAt: new Date().toISOString(),
  });
}));

app.post('/api/scan', asyncRoute(async (req, res) => {
  const scene = req.body && req.body.scene;
  if (!Object.prototype.hasOwnProperty.call(SCENES, scene)) {
    return res.status(400).json({
      error: 'unknown scene',
      service: SERVICE_NAME,
      allowed: Object.keys(SCENES),
    });
  }
  try {
    const power = await spendEnergy(5, 'scan');
    state.mode = 'focused';
    state.scene = scene;
    state.focus = scene;
    state.identified = SCENES[scene];
    touch('scan');
    reportToHead({
      from: SERVICE_NAME,
      scene,
      identified: state.identified,
    });
    actionCounter.inc({ service: SERVICE_NAME, action: 'scan', result: 'ok' });
    log('info', 'scene scanned', { scene, count: state.identified.length });
    return res.json({ ...publicState(power), action: 'scan' });
  } catch (error) {
    return sendError(res, error, 'scan');
  }
}));

app.post('/api/focus', asyncRoute(async (req, res) => {
  const target = String((req.body && req.body.target) || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .'-]{0,39}$/.test(target)) {
    return res.status(400).json({
      error: 'target must be 1-40 letters, numbers, spaces, apostrophes, or hyphens',
      service: SERVICE_NAME,
    });
  }
  try {
    const power = await spendEnergy(2, 'focus');
    state.mode = 'focused';
    state.focus = target;
    touch('focus');
    actionCounter.inc({ service: SERVICE_NAME, action: 'focus', result: 'ok' });
    log('info', 'eyes focused', { target });
    return res.json({ ...publicState(power), action: 'focus' });
  } catch (error) {
    return sendError(res, error, 'focus');
  }
}));

app.post('/api/idle', (req, res) => {
  state.mode = 'idle';
  state.focus = null;
  touch('idle');
  actionCounter.inc({ service: SERVICE_NAME, action: 'idle', result: 'ok' });
  res.json({ ...publicState(), action: 'idle' });
});

function sendStatic(res, file, type) {
  res.set('Cache-Control', 'no-store');
  res.type(type);
  res.sendFile(path.join(__dirname, file));
}

app.get('/', (req, res) => sendStatic(res, 'index.html', 'html'));
app.get('/index.html', (req, res) => sendStatic(res, 'index.html', 'html'));
app.get('/style.css', (req, res) => sendStatic(res, 'style.css', 'css'));
app.get('/script.js', (req, res) => sendStatic(res, 'script.js', 'js'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found', service: SERVICE_NAME });
});

app.use((req, res) => {
  res.status(404).type('text').send('Not found');
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid json', service: SERVICE_NAME });
  }
  log('error', 'unhandled error', { error: error.message });
  return res.status(500).json({ error: 'internal error', service: SERVICE_NAME });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'listening', { port: PORT, track: TRACK, stomach: STOMACH_URL, head: HEAD_URL });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  log('error', 'unhandled rejection', {
    error: error instanceof Error ? error.message : String(error),
  });
});
