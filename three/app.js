const express = require('express');
const client = require('prom-client');
const path = require('path');

const { version } = require('./package.json');

const SERVICE_NAME = 'stomach';
const PORT = Number(process.env.PORT || 3003);
const TRACK = process.env.ROBOT_TRACK || 'v1';
const CAPACITY = 100;

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

const energyGauge = new client.Gauge({
  name: 'robot_energy_level',
  help: 'Magical diamond energy from 0 to 100',
  labelNames: ['service'],
  registers: [register],
});

new client.Gauge({
  name: 'robot_build_info',
  help: 'Static build labels for this process',
  labelNames: ['service', 'version', 'track'],
  registers: [register],
}).set({ service: SERVICE_NAME, version, track: TRACK }, 1);

const startedAt = new Date().toISOString();
let energy = 100;
const history = [];
let lastConsumer = null;
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

function diamondState() {
  if (energy >= 60) return 'stable';
  if (energy >= 35) return 'pulsing';
  if (energy >= 15) return 'low';
  return 'critical';
}

function remember(entry) {
  history.unshift({ at: new Date().toISOString(), ...entry });
  if (history.length > 8) history.length = 8;
}

function publicState() {
  return {
    service: SERVICE_NAME,
    part: 'stomach',
    version,
    track: TRACK,
    energy,
    capacity: CAPACITY,
    diamond: diamondState(),
    chargeRatePerSec: 0.5,
    lastConsumer,
    history,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    updatedAt: new Date().toISOString(),
  };
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

function readAmount(value, max) {
  const amount = Number(value);
  if (!Number.isInteger(amount) || amount < 1 || amount > max) return null;
  return amount;
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

app.get('/api/energy', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    energy,
    capacity: CAPACITY,
    diamond: diamondState(),
  });
});

app.get('/api/ui-config', (req, res) => {
  res.json({
    service: SERVICE_NAME,
    track: TRACK,
    links: links(),
  });
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

app.post('/api/energy/charge', (req, res) => {
  const amount = readAmount(req.body && req.body.amount, 100);
  if (amount == null) {
    actionCounter.inc({ service: SERVICE_NAME, action: 'charge', result: 'error' });
    return res.status(400).json({
      error: 'amount must be an integer from 1 to 100',
      service: SERVICE_NAME,
    });
  }
  energy = Math.min(CAPACITY, energy + amount);
  energyGauge.set({ service: SERVICE_NAME }, energy);
  lastConsumer = 'charge';
  remember({ kind: 'charge', amount, energyAfter: energy, consumer: 'operator' });
  actionCounter.inc({ service: SERVICE_NAME, action: 'charge', result: 'ok' });
  log('info', 'diamond charged', { amount, energy });
  return res.json(publicState());
});

app.post('/api/energy/consume', (req, res) => {
  const amount = readAmount(req.body && req.body.amount, 40);
  const consumer = String((req.body && req.body.consumer) || 'unknown').slice(0, 40);
  const reason = String((req.body && req.body.reason) || 'action').slice(0, 40);
  if (amount == null) {
    actionCounter.inc({ service: SERVICE_NAME, action: 'consume', result: 'error' });
    return res.status(400).json({
      error: 'amount must be an integer from 1 to 40',
      service: SERVICE_NAME,
    });
  }
  if (energy < amount) {
    actionCounter.inc({ service: SERVICE_NAME, action: 'consume', result: 'error' });
    return res.status(409).json({
      error: 'insufficient energy',
      service: SERVICE_NAME,
      energy,
      required: amount,
      diamond: diamondState(),
    });
  }
  energy -= amount;
  energyGauge.set({ service: SERVICE_NAME }, energy);
  lastConsumer = consumer;
  remember({ kind: 'consume', amount, consumer, reason, energyAfter: energy });
  actionCounter.inc({ service: SERVICE_NAME, action: 'consume', result: 'ok' });
  log('info', 'diamond spent', { amount, consumer, reason, energy });
  return res.json({
    ...publicState(),
    spent: amount,
    consumer,
    reason,
  });
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

energyGauge.set({ service: SERVICE_NAME }, energy);
const regenTimer = setInterval(() => {
  if (energy < CAPACITY) {
    energy = Math.min(CAPACITY, energy + 1);
    energyGauge.set({ service: SERVICE_NAME }, energy);
  }
}, 2000);

const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'listening', { port: PORT, track: TRACK });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(regenTimer);
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
