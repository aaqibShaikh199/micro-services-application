const express = require('express');
const client = require('prom-client');
const path = require('path');

const { version } = require('./package.json');

const SERVICE_NAME = 'head';
const PORT = Number(process.env.PORT || 3005);
const TRACK = process.env.ROBOT_TRACK || 'v1';

const TARGETS = {
  legs: process.env.LEGS_URL || 'http://127.0.0.1:3001',
  hands: process.env.HANDS_URL || 'http://127.0.0.1:3002',
  stomach: process.env.STOMACH_URL || 'http://127.0.0.1:3003',
  eyes: process.env.EYES_URL || 'http://127.0.0.1:3004',
};

const ROUTES = {
  legs: new Set(['GET /status', 'POST /move']),
  hands: new Set(['GET /status', 'POST /move']),
  stomach: new Set(['GET /status', 'GET /energy', 'POST /energy/charge', 'POST /energy/consume']),
  eyes: new Set(['GET /status', 'POST /scan', 'POST /focus', 'POST /idle']),
};

const COMMANDS = new Set(['patrol', 'greet', 'scan-room', 'power-check', 'dance', 'rest']);

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
  mode: 'online',
  directive: 'idle',
  lastObservation: null,
  recentCommands: [],
};

let shuttingDown = false;

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

async function requestJson(url, { method = 'GET', body, timeoutMs = 2000, target = 'peer' } = {}) {
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
    upstreamCalls.inc({ service: SERVICE_NAME, target, result: 'error' });
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
    upstreamCalls.inc({ service: SERVICE_NAME, target, result: 'error' });
    const wrapped = new Error(payload.error || `upstream status ${response.status}`);
    wrapped.status = response.status;
    wrapped.payload = payload;
    throw wrapped;
  }
  upstreamCalls.inc({ service: SERVICE_NAME, target, result: 'ok' });
  return payload;
}

function publicState() {
  return {
    service: SERVICE_NAME,
    part: 'head',
    version,
    track: TRACK,
    mode: state.mode,
    directive: state.directive,
    lastObservation: state.lastObservation,
    recentCommands: state.recentCommands,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

async function runStep(transcript, name, target, fn) {
  try {
    const result = await fn();
    transcript.push({ step: name, ok: true, result });
    return true;
  } catch (error) {
    transcript.push({
      step: name,
      ok: false,
      error: error.message,
      upstream: error.payload || null,
    });
    log('warn', 'coordination step failed', { step: name, target, error: error.message });
    return false;
  }
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

app.get('/api/status', (req, res) => {
  res.json(publicState());
});

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

app.get('/api/fleet', asyncRoute(async (req, res) => {
  const entries = await Promise.all(Object.entries(TARGETS).map(async ([name, base]) => {
    try {
      const status = await requestJson(`${base}/api/status`, { timeoutMs: 2000, target: name });
      return [name, { ok: true, status }];
    } catch (error) {
      return [name, { ok: false, error: error.message }];
    }
  }));
  res.json({ head: publicState(), peers: Object.fromEntries(entries) });
}));

app.post('/api/observations', (req, res) => {
  const body = req.body || {};
  const identified = Array.isArray(body.identified) ? body.identified.slice(0, 8) : [];
  state.lastObservation = {
    from: String(body.from || 'unknown').slice(0, 40),
    scene: typeof body.scene === 'string' ? body.scene.slice(0, 40) : null,
    identified,
    at: new Date().toISOString(),
  };
  log('info', 'observation stored', { scene: state.lastObservation.scene });
  res.status(202).json({ accepted: true, observation: state.lastObservation });
});

app.use('/api/parts/:part', asyncRoute(async (req, res) => {
  const part = req.params.part;
  const allowed = ROUTES[part];
  if (!allowed) {
    return res.status(404).json({ error: 'unknown part', service: SERVICE_NAME, known: Object.keys(ROUTES) });
  }
  const rest = req.url.split('?')[0] || '/';
  const key = `${req.method} ${rest}`;
  if (!allowed.has(key)) {
    return res.status(404).json({
      error: 'unknown part route',
      service: SERVICE_NAME,
      allowed: [...allowed],
    });
  }
  try {
    const result = await requestJson(`${TARGETS[part]}/api${rest}`, {
      method: req.method,
      body: req.method === 'GET' ? undefined : req.body,
      timeoutMs: 2500,
      target: part,
    });
    return res.json(result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    return res.status(status).json({
      error: error.message,
      service: SERVICE_NAME,
      target: part,
      upstream: error.payload || null,
    });
  }
}));

app.post('/api/command', asyncRoute(async (req, res) => {
  const command = req.body && req.body.command;
  if (!COMMANDS.has(command)) {
    return res.status(400).json({
      error: 'unknown command',
      service: SERVICE_NAME,
      allowed: [...COMMANDS],
    });
  }

  state.mode = 'coordinating';
  state.directive = command;
  const transcript = [];
  let ok = true;

  async function step(name, target, fn) {
    if (!ok && command !== 'rest') return;
    const passed = await runStep(transcript, name, target, fn);
    if (!passed) ok = false;
  }

  if (command === 'patrol') {
    await step('legs.walk', 'legs', () => requestJson(`${TARGETS.legs}/api/move`, {
      method: 'POST', body: { action: 'walk' }, timeoutMs: 2500, target: 'legs',
    }));
    await step('eyes.scan', 'eyes', () => requestJson(`${TARGETS.eyes}/api/scan`, {
      method: 'POST', body: { scene: 'warehouse' }, timeoutMs: 2500, target: 'eyes',
    }));
    await step('hands.point', 'hands', () => requestJson(`${TARGETS.hands}/api/move`, {
      method: 'POST', body: { action: 'point' }, timeoutMs: 2500, target: 'hands',
    }));
  } else if (command === 'greet') {
    await step('hands.wave', 'hands', () => requestJson(`${TARGETS.hands}/api/move`, {
      method: 'POST', body: { action: 'wave' }, timeoutMs: 2500, target: 'hands',
    }));
    await step('eyes.focus', 'eyes', () => requestJson(`${TARGETS.eyes}/api/focus`, {
      method: 'POST', body: { target: 'visitor' }, timeoutMs: 2500, target: 'eyes',
    }));
  } else if (command === 'scan-room') {
    await step('eyes.scan', 'eyes', () => requestJson(`${TARGETS.eyes}/api/scan`, {
      method: 'POST', body: { scene: 'lab' }, timeoutMs: 2500, target: 'eyes',
    }));
  } else if (command === 'power-check') {
    await step('stomach.status', 'stomach', () => requestJson(`${TARGETS.stomach}/api/energy`, {
      timeoutMs: 1500, target: 'stomach',
    }));
  } else if (command === 'dance') {
    await step('legs.walk', 'legs', () => requestJson(`${TARGETS.legs}/api/move`, {
      method: 'POST', body: { action: 'walk' }, timeoutMs: 2500, target: 'legs',
    }));
    await step('hands.clap', 'hands', () => requestJson(`${TARGETS.hands}/api/move`, {
      method: 'POST', body: { action: 'clap' }, timeoutMs: 2500, target: 'hands',
    }));
  } else if (command === 'rest') {
    await step('legs.stop', 'legs', () => requestJson(`${TARGETS.legs}/api/move`, {
      method: 'POST', body: { action: 'stop' }, timeoutMs: 2500, target: 'legs',
    }));
    await step('hands.rest', 'hands', () => requestJson(`${TARGETS.hands}/api/move`, {
      method: 'POST', body: { action: 'rest' }, timeoutMs: 2500, target: 'hands',
    }));
    await step('eyes.idle', 'eyes', () => requestJson(`${TARGETS.eyes}/api/idle`, {
      method: 'POST', body: {}, timeoutMs: 2500, target: 'eyes',
    }));
  }

  if (command === 'rest') state.mode = 'resting';
  else if (command === 'power-check') {
    const energy = transcript[0] && transcript[0].ok ? transcript[0].result.energy : null;
    state.mode = !ok || energy == null || energy < 30 ? 'alert' : 'online';
  } else state.mode = ok ? 'online' : 'alert';

  state.recentCommands.unshift(command);
  if (state.recentCommands.length > 6) state.recentCommands.length = 6;
  actionCounter.inc({ service: SERVICE_NAME, action: command, result: ok ? 'ok' : 'error' });
  log('info', 'command finished', { command, ok });

  return res.status(ok ? 200 : 502).json({
    command,
    ok,
    transcript,
    head: publicState(),
  });
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
  log('info', 'listening', { port: PORT, track: TRACK, targets: TARGETS });
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
