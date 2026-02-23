require('./instrumentation');

const express = require('express');
const axios = require('axios');
const winston = require('winston');
const { trace } = require('@opentelemetry/api');
require('dotenv').config();

const app = express();
app.use(express.json());

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'chaos-controller' },
  transports: [new winston.transports.Console()],
});

const SERVICES = {
  claims:       process.env.CLAIMS_SERVICE_URL       || 'http://localhost:3001',
  policy:       process.env.POLICY_SERVICE_URL       || 'http://localhost:8080',
  investment:   process.env.INVESTMENT_SERVICE_URL   || 'http://localhost:3002',
  notification: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3003',
};

// Master chaos state
let masterState = {
  claims:       { service_crash: false, high_latency: false, db_failure: false, memory_spike: false, cpu_spike: false },
  policy:       { service_crash: false, high_latency: false, db_failure: false, memory_spike: false, cpu_spike: false },
  investment:   { service_crash: false, high_latency: false, db_failure: false, memory_spike: false, cpu_spike: false },
  notification: { service_crash: false, high_latency: false, db_failure: false, memory_spike: false, cpu_spike: false },
};

async function propagateChaos(service, state) {
  const url = `${SERVICES[service]}/chaos/set`;
  try {
    await axios.post(url, state, { timeout: 5000 });
    logger.warn(`Chaos propagated to ${service}`, state);
  } catch (err) {
    logger.error(`Failed to propagate chaos to ${service}: ${err.message}`);
  }
}

// API routes
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'chaos-controller' }));

app.get('/chaos/status', async (req, res) => {
  const status = {};
  for (const [name, url] of Object.entries(SERVICES)) {
    try {
      const r = await axios.get(`${url}/health`, { timeout: 3000 });
      status[name] = { healthy: true, chaos: r.data.chaos || {} };
    } catch {
      status[name] = { healthy: false, chaos: masterState[name] };
    }
  }
  res.json({ services: status, masterState });
});

app.post('/chaos/toggle', async (req, res) => {
  const { service, fault, enabled } = req.body;
  const tracer = trace.getTracer('chaos-controller');
  const span = tracer.startSpan('chaos_toggle');
  span.setAttribute('chaos.service', service);
  span.setAttribute('chaos.fault', fault);
  span.setAttribute('chaos.enabled', enabled);

  if (service === 'all') {
    for (const svc of Object.keys(masterState)) {
      masterState[svc][fault] = enabled;
      await propagateChaos(svc, { [fault]: enabled });
    }
  } else if (masterState[service]) {
    masterState[service][fault] = enabled;
    await propagateChaos(service, { [fault]: enabled });
  }

  logger.warn(`Chaos toggle: ${service}.${fault} = ${enabled}`);
  span.end();
  res.json({ status: 'updated', masterState });
});

app.post('/chaos/reset', async (req, res) => {
  for (const svc of Object.keys(masterState)) {
    for (const fault of Object.keys(masterState[svc])) {
      masterState[svc][fault] = false;
    }
    await propagateChaos(svc, masterState[svc]);
  }
  logger.info('All chaos reset');
  res.json({ status: 'reset', masterState });
});

app.post('/chaos/scenario/cascading', async (req, res) => {
  logger.warn('🌊 Cascading failure scenario triggered!');
  const sequence = [
    { delay: 0,    service: 'claims',     fault: 'high_latency', enabled: true },
    { delay: 2000, service: 'policy',     fault: 'high_latency', enabled: true },
    { delay: 4000, service: 'claims',     fault: 'db_failure',   enabled: true },
    { delay: 6000, service: 'investment', fault: 'service_crash',enabled: true },
    { delay: 8000, service: 'notification',fault:'service_crash',enabled: true },
  ];
  for (const step of sequence) {
    setTimeout(async () => {
      masterState[step.service][step.fault] = step.enabled;
      await propagateChaos(step.service, { [step.fault]: step.enabled });
      logger.warn(`Cascade step: ${step.service}.${step.fault} triggered`);
    }, step.delay);
  }
  res.json({ status: 'cascading_failure_started', steps: sequence.length });
});

// ── Embedded UI ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>InsureWatch — Chaos Controller</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Courier New', monospace; background: #0a0e1a; color: #e0e6f0; min-height: 100vh; }
    header { background: #0d1628; border-bottom: 1px solid #1e3a5f; padding: 16px 32px; display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 20px; color: #f5a623; letter-spacing: 2px; }
    header span { font-size: 12px; color: #5a7a9a; letter-spacing: 3px; }
    .badge { background: #1a3a2a; color: #4caf50; border: 1px solid #4caf50; border-radius: 4px; padding: 2px 10px; font-size: 11px; }
    .badge.danger { background: #3a1a1a; color: #f44336; border-color: #f44336; }
    main { padding: 32px; max-width: 1200px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; margin-bottom: 32px; }
    .card { background: #0d1628; border: 1px solid #1e3a5f; border-radius: 8px; padding: 20px; }
    .card h2 { font-size: 13px; letter-spacing: 3px; color: #5a7a9a; margin-bottom: 16px; text-transform: uppercase; }
    .service-name { font-size: 16px; color: #e0e6f0; margin-bottom: 4px; }
    .service-lang { font-size: 11px; color: #5a7a9a; margin-bottom: 16px; letter-spacing: 2px; }
    .health-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; }
    .health-ok { background: #4caf50; box-shadow: 0 0 6px #4caf50; }
    .health-err { background: #f44336; box-shadow: 0 0 6px #f44336; }
    .fault-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #1e3a5f; }
    .fault-row:last-child { border-bottom: none; }
    .fault-label { font-size: 12px; color: #c0ccdd; }
    .fault-icon { margin-right: 6px; }
    .toggle { position: relative; width: 44px; height: 24px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background: #1e3a5f; border-radius: 24px; transition: .3s; }
    .slider:before { content: ''; position: absolute; height: 18px; width: 18px; left: 3px; bottom: 3px; background: #5a7a9a; border-radius: 50%; transition: .3s; }
    input:checked + .slider { background: #f44336; }
    input:checked + .slider:before { transform: translateX(20px); background: white; }
    .scenarios { margin-bottom: 32px; }
    .scenarios h2 { font-size: 13px; letter-spacing: 3px; color: #5a7a9a; margin-bottom: 16px; text-transform: uppercase; }
    .scenario-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .scenario-btn { background: #0d1628; border: 1px solid #1e3a5f; border-radius: 8px; padding: 16px; cursor: pointer; text-align: left; color: #e0e6f0; transition: all .2s; }
    .scenario-btn:hover { border-color: #f5a623; background: #111e35; }
    .scenario-btn.danger:hover { border-color: #f44336; }
    .scenario-btn .icon { font-size: 24px; margin-bottom: 8px; display: block; }
    .scenario-btn .title { font-size: 13px; font-weight: bold; margin-bottom: 4px; }
    .scenario-btn .desc { font-size: 11px; color: #5a7a9a; }
    .reset-btn { background: #1e3a5f; border: 1px solid #2a5a8f; border-radius: 8px; padding: 12px 24px; color: #e0e6f0; cursor: pointer; font-family: 'Courier New'; font-size: 13px; letter-spacing: 2px; transition: all .2s; }
    .reset-btn:hover { background: #2a5a8f; }
    .log { background: #070b14; border: 1px solid #1e3a5f; border-radius: 8px; padding: 16px; height: 160px; overflow-y: auto; font-size: 11px; color: #4a7a5a; }
    .log .entry { margin-bottom: 4px; }
    .log .entry.warn { color: #f5a623; }
    .log .entry.error { color: #f44336; }
    .status-bar { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .status-pill { background: #0d1628; border: 1px solid #1e3a5f; border-radius: 20px; padding: 6px 14px; font-size: 11px; letter-spacing: 2px; display: flex; align-items: center; gap: 6px; }
  </style>
</head>
<body>
<header>
  <div>
    <h1>⚡ INSUREWATCH CHAOS CONTROLLER</h1>
    <span>RESILIENCE TESTING DASHBOARD</span>
  </div>
  <span class="badge" id="system-badge">● SYSTEM NOMINAL</span>
</header>
<main>
  <div class="status-bar" id="status-bar"></div>

  <div class="scenarios">
    <h2>⚡ Quick Scenarios</h2>
    <div class="scenario-grid">
      <button class="scenario-btn" onclick="triggerScenario('cascading')">
        <span class="icon">🌊</span>
        <div class="title">Cascading Failure</div>
        <div class="desc">Sequential failure across all services</div>
      </button>
      <button class="scenario-btn" onclick="toggleAll('high_latency', true)">
        <span class="icon">🐢</span>
        <div class="title">System-Wide Latency</div>
        <div class="desc">Inject 3-8s delays everywhere</div>
      </button>
      <button class="scenario-btn" onclick="toggleAll('db_failure', true)">
        <span class="icon">🗄️</span>
        <div class="title">Database Blackout</div>
        <div class="desc">Simulate DB failure across services</div>
      </button>
      <button class="scenario-btn" onclick="toggleAll('memory_spike', true)">
        <span class="icon">🔥</span>
        <div class="title">Memory Pressure</div>
        <div class="desc">Spike memory on all services</div>
      </button>
      <button class="scenario-btn danger" onclick="resetAll()">
        <span class="icon">✅</span>
        <div class="title">Reset All</div>
        <div class="desc">Restore all services to healthy state</div>
      </button>
    </div>
  </div>

  <div class="grid" id="service-grid"></div>

  <div style="margin-bottom:16px">
    <h2 style="font-size:13px;letter-spacing:3px;color:#5a7a9a;margin-bottom:12px;text-transform:uppercase">📋 Activity Log</h2>
    <div class="log" id="activity-log"><div class="entry">// Chaos controller ready. Waiting for commands...</div></div>
  </div>
</main>

<script>
const FAULTS = [
  { key: 'service_crash', label: 'Service Crash',   icon: '💀' },
  { key: 'high_latency',  label: 'High Latency',    icon: '🐢' },
  { key: 'db_failure',    label: 'DB Failure',      icon: '🗄️' },
  { key: 'memory_spike',  label: 'Memory Spike',    icon: '🔥' },
  { key: 'cpu_spike',     label: 'CPU Spike',        icon: '⚡' },
];

const SERVICES_META = {
  claims:       { name: 'Claims Service',       lang: 'PYTHON · FASTAPI' },
  policy:       { name: 'Policy Service',       lang: 'JAVA · SPRING BOOT' },
  investment:   { name: 'Investment Service',   lang: 'NODE.JS · EXPRESS' },
  notification: { name: 'Notification Service', lang: 'PYTHON · FASTAPI' },
};

let state = {};
const log = document.getElementById('activity-log');

function addLog(msg, level = 'info') {
  const d = new Date().toISOString().substring(11, 19);
  const el = document.createElement('div');
  el.className = \`entry \${level}\`;
  el.textContent = \`[\${d}] \${msg}\`;
  log.prepend(el);
}

async function fetchStatus() {
  try {
    const r = await fetch('/chaos/status');
    const data = await r.json();
    state = data.masterState;
    renderGrid(data);
    updateStatusBar(data.services);
  } catch(e) { addLog('Status fetch failed: ' + e.message, 'error'); }
}

function renderGrid(data) {
  const grid = document.getElementById('service-grid');
  grid.innerHTML = '';
  for (const [svc, meta] of Object.entries(SERVICES_META)) {
    const svcData = data.services[svc] || {};
    const healthy = svcData.healthy !== false;
    const card = document.createElement('div');
    card.className = 'card';
    const anyActive = Object.values(state[svc] || {}).some(v => v);
    card.innerHTML = \`
      <h2>Service</h2>
      <div style="display:flex;align-items:center;margin-bottom:4px">
        <span class="health-dot \${healthy ? 'health-ok' : 'health-err'}"></span>
        <span class="service-name">\${meta.name}</span>
      </div>
      <div class="service-lang">\${meta.lang}</div>
      \${FAULTS.map(f => \`
        <div class="fault-row">
          <span class="fault-label"><span class="fault-icon">\${f.icon}</span>\${f.label}</span>
          <label class="toggle">
            <input type="checkbox" \${(state[svc] || {})[f.key] ? 'checked' : ''}
              onchange="toggleFault('\${svc}', '\${f.key}', this.checked)"/>
            <span class="slider"></span>
          </label>
        </div>
      \`).join('')}
    \`;
    grid.appendChild(card);
  }
}

function updateStatusBar(services) {
  const bar = document.getElementById('status-bar');
  bar.innerHTML = '';
  let anyDown = false;
  for (const [name, data] of Object.entries(services)) {
    const ok = data.healthy !== false;
    if (!ok) anyDown = true;
    bar.innerHTML += \`<div class="status-pill">
      <span class="health-dot \${ok ? 'health-ok' : 'health-err'}"></span>
      \${name.toUpperCase()}
    </div>\`;
  }
  const badge = document.getElementById('system-badge');
  badge.textContent = anyDown ? '● DEGRADED' : '● SYSTEM NOMINAL';
  badge.className = anyDown ? 'badge danger' : 'badge';
}

async function toggleFault(service, fault, enabled) {
  addLog(\`Toggle: \${service}.\${fault} → \${enabled ? 'ON' : 'OFF'}\`, enabled ? 'warn' : 'info');
  await fetch('/chaos/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service, fault, enabled }),
  });
  fetchStatus();
}

async function toggleAll(fault, enabled) {
  addLog(\`System-wide: \${fault} → \${enabled ? 'ON' : 'OFF'}\`, 'warn');
  await fetch('/chaos/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'all', fault, enabled }),
  });
  fetchStatus();
}

async function triggerScenario(name) {
  addLog(\`🌊 Scenario triggered: \${name}\`, 'warn');
  await fetch(\`/chaos/scenario/\${name}\`, { method: 'POST' });
  setTimeout(fetchStatus, 1000);
}

async function resetAll() {
  addLog('✅ All chaos reset', 'info');
  await fetch('/chaos/reset', { method: 'POST' });
  fetchStatus();
}

fetchStatus();
setInterval(fetchStatus, 5000);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () => {
  logger.info(`Chaos Controller started on port ${PORT}`);
  logger.info('UI available at http://localhost:' + PORT);
});
