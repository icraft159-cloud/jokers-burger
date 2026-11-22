'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const PUBLIC_FILES = new Set([
  'index.html', 'style.css', 'script.js', 'logo.png',
  'cozinha.html', 'cozinha.css', 'cozinha.js',
  'entregador.html', 'entregador.css', 'entregador.js',
  'favicon.ico'
]);

const ORDER_STATUS = new Set(['novo', 'preparo', 'pronto', 'entregue', 'cancelado']);
const DELIVERY_STATUS = new Set(['aguardando', 'aceito', 'rota', 'entregue']);
const PAYMENTS = new Set(['Pix', 'Cartão de Crédito', 'Cartão de Débito', 'Dinheiro']);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function defaultDelivery(order) {
  const delivered = order.status === 'entregue';
  return {
    status: delivered ? 'entregue' : 'aguardando',
    driver: null, acceptedAt: null, pickedUpAt: null,
    deliveredAt: delivered ? order.updatedAt : null, history: []
  };
}

let db = readJson(ORDERS_FILE, { seq: { date: '', n: 0 }, orders: [] });
if (!db.seq) db.seq = { date: '', n: 0 };
if (!Array.isArray(db.orders)) db.orders = [];
db.orders = db.orders.map(o => ({
  ...o,
  delivery: o.delivery ? { ...defaultDelivery(o), ...o.delivery } : defaultDelivery(o)
}));
writeJson(ORDERS_FILE, db);

function saveDb() {
  if (db.orders.length > 1000) db.orders = db.orders.slice(-1000);
  writeJson(ORDERS_FILE, db);
}

function sha256(v) { return crypto.createHash('sha256').update(String(v)).digest(); }
function safeEqual(a, b) { return crypto.timingSafeEqual(sha256(a), sha256(b)); }

function ensurePins() {
  let cfg = readJson(CONFIG_FILE, {});
  let changed = false;
  if (process.env.KITCHEN_PIN) cfg.kitchenPin = String(process.env.KITCHEN_PIN);
  else if (!cfg.kitchenPin) { cfg.kitchenPin = String(crypto.randomInt(100000, 999999)); changed = true; }
  if (process.env.DELIVERY_PIN) cfg.deliveryPin = String(process.env.DELIVERY_PIN);
  else if (!cfg.deliveryPin) { cfg.deliveryPin = String(crypto.randomInt(100000, 999999)); changed = true; }
  delete cfg.pin;
  if (changed) writeJson(CONFIG_FILE, cfg);
  return cfg;
}

const pins = ensurePins();
const KITCHEN_PIN = pins.kitchenPin;
const DELIVERY_PIN = pins.deliveryPin;

const sessions = new Map();
const loginAttempts = new Map();
const orderAttempts = new Map();
const sseClients = new Set();

function rateLimit(map, key, limit, windowMs) {
  const now = Date.now();
  const item = map.get(key) || { count: 0, reset: now + windowMs };
  if (now > item.reset) { item.count = 0; item.reset = now + windowMs; }
  item.count += 1;
  map.set(key, item);
  return item.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
  for (const [k, v] of loginAttempts) if (v.reset < now) loginAttempts.delete(k);
  for (const [k, v] of orderAttempts) if (v.reset < now) orderAttempts.delete(k);
}, 60000).unref();

function issueToken(role, driver = '') {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { role, driver, expires: Date.now() + 12 * 60 * 60 * 1000 });
  return token;
}
function getToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
}
function requireSession(req, res, next) {
  const session = sessions.get(getToken(req));
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: 'Sessão inválida. Entre novamente.' });
  }
  req.session = session;
  next();
}
function requireKitchen(req, res, next) {
  requireSession(req, res, () => {
    if (req.session.role !== 'kitchen') return res.status(403).json({ error: 'Acesso restrito à cozinha.' });
    next();
  });
}
function requireDelivery(req, res, next) {
  requireSession(req, res, () => {
    if (req.session.role !== 'delivery') return res.status(403).json({ error: 'Acesso restrito ao entregador.' });
    next();
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const client of sseClients) {
    try { sseSend(client, event, data); } catch { sseClients.delete(client); }
  }
}
setInterval(() => {
  for (const c of sseClients) {
    try { c.write(': ping\n\n'); } catch { sseClients.delete(c); }
  }
}, 25000).unref();

const cleanText = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const money = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

function setOrderStatus(order, status, now) {
  if (order.status === status) return;
  order.status = status;
  order.updatedAt = now;
  order.history = Array.isArray(order.history) ? order.history : [];
  order.history.push({ status, at: now });
}
function applyDeliveryState(order, target, driver, now) {
  const d = order.delivery;
  d.status = target;
  if (target === 'aguardando') {
    d.driver = null; d.acceptedAt = null; d.pickedUpAt = null; d.deliveredAt = null;
    if (order.status === 'entregue') setOrderStatus(order, 'pronto', now);
  } else if (target === 'aceito') {
    d.driver = d.driver || driver || 'Entregador';
    d.acceptedAt = d.acceptedAt || now; d.pickedUpAt = null; d.deliveredAt = null;
    if (order.status === 'entregue') setOrderStatus(order, 'pronto', now);
  } else if (target === 'rota') {
    d.driver = d.driver || driver || 'Entregador';
    d.acceptedAt = d.acceptedAt || now; d.pickedUpAt = now; d.deliveredAt = null;
    if (order.status === 'entregue') setOrderStatus(order, 'pronto', now);
  } else if (target === 'entregue') {
    d.driver = d.driver || driver || 'Entregador';
    d.acceptedAt = d.acceptedAt || now; d.pickedUpAt = d.pickedUpAt || now;
    d.deliveredAt = now;
    setOrderStatus(order, 'entregue', now);
  }
  d.history = Array.isArray(d.history) ? d.history : [];
  d.history.push({ status: target, at: now, driver: d.driver });
}

function validateOrderPayload(body) {
  const c = body.customer || {};
  const p = body.payment || {};
  const items = body.items;
  const nome = cleanText(c.nome, 120);
  const telefone = cleanText(c.telefone, 40);
  const endereco = cleanText(c.endereco, 240);
  const complemento = cleanText(c.complemento, 160);
  const metodo = cleanText(p.metodo, 40);
  const troco = cleanText(p.troco, 40);
  const notes = cleanText(body.notes, 500);
  if (nome.length < 2) throw new Error('Informe o nome do cliente.');
  if (telefone.replace(/\D/g, '').length < 8) throw new Error('Telefone inválido.');
  if (endereco.length < 5) throw new Error('Informe o endereço de entrega.');
  if (!PAYMENTS.has(metodo)) throw new Error('Forma de pagamento inválida.');
  if (!Array.isArray(items) || !items.length) throw new Error('O pedido precisa ter itens.');
  if (items.length > 60) throw new Error('Pedido muito grande.');
  const cleanItems = items.map((raw, i) => {
    const itemNome = cleanText(raw.nome, 140);
    const qtd = Number(raw.qtd);
    const preco = Number(raw.preco);
    if (!itemNome) throw new Error(`Item ${i + 1} sem nome.`);
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > 99) throw new Error(`Quantidade inválida no item ${i + 1}.`);
    if (!Number.isFinite(preco) || preco < 0 || preco > 10000) throw new Error(`Preço inválido no item ${i + 1}.`);
    const adicionais = Array.isArray(raw.adicionais) ? raw.adicionais.slice(0, 15).map(ad => {
      const n = cleanText(ad.nome, 100);
      const v = Number(ad.preco);
      if (!n || !Number.isFinite(v) || v < 0) throw new Error(`Adicional inválido no item ${i + 1}.`);
      return { nome: n, preco: money(v) };
    }) : [];
    return {
      produtoId: cleanText(raw.produtoId, 40),
      tipo: raw.tipo === 'combo' ? 'combo' : 'produto',
      nome: itemNome, qtd, preco: money(preco), adicionais,
      observacoes: cleanText(raw.observacoes, 400)
    };
  });
  const subtotal = money(cleanItems.reduce((s, it) => s + it.preco * it.qtd, 0));
  let deliveryFee = null;
  if (body.deliveryFee !== null && body.deliveryFee !== undefined && body.deliveryFee !== '') {
    const fee = Number(body.deliveryFee);
    if (!Number.isFinite(fee) || fee < 0) throw new Error('Taxa de entrega inválida.');
    deliveryFee = money(fee);
  }
  return {
    customer: { nome, telefone, endereco, complemento },
    payment: { metodo, troco },
    notes, items: cleanItems,
    totals: {
      subtotal, deliveryFee,
      deliveryFeeText: deliveryFee === null ? cleanText(body.deliveryFeeText || 'A combinar', 60) : '',
      total: money(subtotal + (deliveryFee || 0))
    }
  };
}

function nextOrderNumber() {
  const today = new Date().toISOString().slice(0, 10);
  if (db.seq.date !== today) db.seq = { date: today, n: 0 };
  db.seq.n += 1;
  return String(db.seq.n).padStart(3, '0');
}

app.use(express.json({ limit: '120kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

function handleLogin(pinExpected, role) {
  return (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'local';
    if (!rateLimit(loginAttempts, `${role}:${ip}`, 8, 5 * 60 * 1000)) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    }
    const pin = cleanText(req.body.pin, 40);
    if (!safeEqual(pin, pinExpected)) return res.status(401).json({ error: 'PIN incorreto.' });
    const driver = role === 'delivery' ? (cleanText(req.body.name, 60) || 'Entregador') : '';
    res.json({ token: issueToken(role, driver), role, driver });
  };
}

app.post('/api/kitchen/login', handleLogin(KITCHEN_PIN, 'kitchen'));
app.post('/api/delivery/login', handleLogin(DELIVERY_PIN, 'delivery'));

app.get('/api/orders', requireKitchen, (req, res) => {
  res.json({ orders: [...db.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.post('/api/orders', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'local';
  if (!rateLimit(orderAttempts, ip, 30, 60 * 1000)) {
    return res.status(429).json({ error: 'Muitos pedidos em sequência. Aguarde um instante.' });
  }
  let payload;
  try { payload = validateOrderPayload(req.body); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const now = new Date().toISOString();
  const order = {
    id: crypto.randomUUID(),
    numero: nextOrderNumber(),
    status: 'novo', createdAt: now, updatedAt: now,
    ...payload, history: [{ status: 'novo', at: now }]
  };
  order.delivery = defaultDelivery(order);
  db.orders.push(order);
  saveDb();
  broadcast('order', { type: 'new', order });
  res.status(201).json({ ok: true, order });
});

app.patch('/api/orders/:id/status', requireKitchen, (req, res) => {
  const status = cleanText(req.body.status, 20);
  if (!ORDER_STATUS.has(status)) return res.status(400).json({ error: 'Status inválido.' });
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const now = new Date().toISOString();
  setOrderStatus(order, status, now);
  if (status === 'entregue') {
    applyDeliveryState(order, 'entregue', order.delivery.driver || 'Cozinha', now);
  } else if (status === 'cancelado') {
    order.delivery.status = 'aguardando';
  } else if (status === 'pronto' && order.delivery.status === 'entregue') {
    applyDeliveryState(order, 'aguardando', '', now);
  }
  saveDb();
  broadcast('order', { type: 'update', order });
  res.json({ ok: true, order });
});

app.get('/api/delivery/orders', requireDelivery, (req, res) => {
  res.json({ orders: [...db.orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) });
});

app.patch('/api/delivery/orders/:id', requireDelivery, (req, res) => {
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (order.status === 'cancelado') return res.status(400).json({ error: 'Pedido cancelado.' });
  const action = cleanText(req.body.action, 20);
  const now = new Date().toISOString();
  const driver = req.session.driver || 'Entregador';
  const d = order.delivery;
  if (action === 'accept') {
    if (order.status !== 'pronto') return res.status(400).json({ error: 'O pedido ainda não está pronto.' });
    if (d.status !== 'aguardando') return res.status(409).json({ error: 'Esta entrega já foi aceita.' });
    applyDeliveryState(order, 'aceito', driver, now);
  } else if (action === 'start') {
    if (d.status !== 'aceito') return res.status(400).json({ error: 'Aceite a entrega antes de iniciar a rota.' });
    applyDeliveryState(order, 'rota', driver, now);
  } else if (action === 'deliver') {
    if (!['aceito', 'rota'].includes(d.status)) return res.status(400).json({ error: 'Esta entrega não está em andamento.' });
    applyDeliveryState(order, 'entregue', driver, now);
  } else if (action === 'release') {
    if (!['aceito', 'rota'].includes(d.status)) return res.status(400).json({ error: 'Esta entrega não está com você.' });
    applyDeliveryState(order, 'aguardando', '', now);
  } else if (action === 'revert') {
    const to = cleanText(req.body.to, 20);
    if (!DELIVERY_STATUS.has(to)) return res.status(400).json({ error: 'Estado inválido.' });
    applyDeliveryState(order, to, driver, now);
  } else {
    return res.status(400).json({ error: 'Ação inválida.' });
  }
  saveDb();
  broadcast('order', { type: 'update', order });
  broadcast('delivery', { type: action, order });
  res.json({ ok: true, order });
});

app.get('/api/events', requireSession, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  sseSend(res, 'hello', { ok: true, role: req.session.role, at: new Date().toISOString() });
  req.on('close', () => { sseClients.delete(res); res.end(); });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'jokers-burger', orders: db.orders.length });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/cozinha', (req, res) => res.sendFile(path.join(ROOT, 'cozinha.html')));
app.get('/entregador', (req, res) => res.sendFile(path.join(ROOT, 'entregador.html')));

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const file = path.basename(req.path);
  if (PUBLIC_FILES.has(file)) return res.sendFile(path.join(ROOT, file));
  next();
});

app.use((req, res) => res.status(404).send('Não encontrado.'));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

app.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) ips.push(item.address);
    }
  }
  console.log('\n🍔 JOKER\'S BURGER no ar');
  console.log(`   Site:       http://localhost:${PORT}`);
  console.log(`   Cozinha:    http://localhost:${PORT}/cozinha.html`);
  console.log(`   Entregador: http://localhost:${PORT}/entregador.html`);
  ips.forEach(ip => console.log(`   Rede:       http://${ip}:${PORT}`));
  console.log(`   PIN Cozinha:    ${KITCHEN_PIN}`);
  console.log(`   PIN Entregador: ${DELIVERY_PIN}`);
  console.log(`   Pedidos: ${ORDERS_FILE}\n`);
});