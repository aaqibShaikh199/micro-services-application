const express = require('express');
const client = require('prom-client');
const path = require('path');

const { version } = require('./package.json');

const SERVICE_NAME = 'legs';
const PORT = Number(process.env.PORT || 3001);
const TRACK = process.env.ROBOT_TRACK || 'v1';
const STOMACH_URL = process.env.STOMACH_URL || 'http://127.0.0.1:3003';
const REQUIRE_ENERGY = process.env.REQUIRE_ENERGY === 'true';

const COSTS = {
  walk: 4,
  stop: 0,
  crouch: 2,
  jump: 8,
  kick: 6,
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
  posture: 'standing',
  left: 'planted',
  right: 'planted',
  steps: 0,
  lastAction: 'boot',
  updatedAt: startedAt,
};

let shuttingDown = false;
let stepTimer = null;
let motionTimer = null;
let stride = 0;
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

function clearMotion() {
  if (stepTimer) clearInterval(stepTimer);
  if (motionTimer) clearTimeout(motionTimer);
  stepTimer = null;
  motionTimer = null;
}

function touch(action) {
  state.lastAction = action;
  state.updatedAt = new Date().toISOString();
}

function applyAction(action) {
  clearMotion();
  if (action === 'walk') {
    state.posture = 'walking';
    stride = 0;
    stepTimer = setInterval(() => {
      stride += 1;
      state.steps += 1;
      state.left = stride % 2 === 0 ? 'forward' : 'back';
      state.right = stride % 2 === 0 ? 'back' : 'forward';
      state.updatedAt = new Date().toISOString();
    }, 700);
  } else if (action === 'stop') {
    state.posture = 'standing';
    state.left = 'planted';
    state.right = 'planted';
  } else if (action === 'crouch') {
    state.posture = 'crouching';
    state.left = 'bent';
    state.right = 'bent';
  } else if (action === 'jump') {
    state.posture = 'jumping';
    state.left = 'tucked';
    state.right = 'tucked';
    motionTimer = setTimeout(() => {
      if (state.posture === 'jumping') {
        state.posture = 'standing';
        state.left = 'planted';
        state.right = 'planted';
        state.updatedAt = new Date().toISOString();
      }
    }, 700);
  } else if (action === 'kick') {
    state.posture = 'kicking';
    state.left = 'planted';
    state.right = 'extended';
    motionTimer = setTimeout(() => {
      if (state.posture === 'kicking') {
        state.posture = 'standing';
        state.left = 'planted';
        state.right = 'planted';
        state.updatedAt = new Date().toISOString();
      }
    }, 700);
  }
  touch(action);
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
    part: 'legs',
    version,
    track: TRACK,
    posture: state.posture,
    left: state.left,
    right: state.right,
    steps: state.steps,
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
  const power = await readPower();
  res.json(publicState(power));
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

app.post('/api/move', asyncRoute(async (req, res) => {
  const action = req.body && req.body.action;
  if (!Object.prototype.hasOwnProperty.call(COSTS, action)) {
    return res.status(400).json({
      error: 'unknown action',
      service: SERVICE_NAME,
      allowed: Object.keys(COSTS),
    });
  }
  try {
    const power = await spendEnergy(COSTS[action], action);
    applyAction(action);
    actionCounter.inc({ service: SERVICE_NAME, action, result: 'ok' });
    log('info', 'legs moved', { action, posture: state.posture });
    return res.json({ ...publicState(power), action });
  } catch (error) {
    log('warn', 'legs move rejected', { action, error: error.message });
    return sendError(res, error, action);
  }
}));

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
  log('info', 'listening', { port: PORT, track: TRACK, stomach: STOMACH_URL });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearMotion();
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
