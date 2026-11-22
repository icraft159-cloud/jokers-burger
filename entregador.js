'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });

const DELIVERY_LABEL = {
  aguardando: 'Na cozinha',
  disponivel: 'Pronto p/ retirada',
  aceito: 'Aceita',
  rota: 'Em rota',
  entregue: 'Entregue',
  cancelado: 'Cancelado'
};

let token = sessionStorage.getItem('jokers_delivery_token') || '';
let driverName = localStorage.getItem('jokers_delivery_name') || '';
let orders = new Map();
let filterStatus = 'todos';
let searchQuery = '';
let sortMode = 'urgentes';
let eventSource = null;
let pollTimer = null;
let soundOn = localStorage.getItem('jokers_delivery_sound') !== 'off';
let audioCtx = null;
let currentDrawerId = null;
let timersStarted = false;

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => map[c]);
}
function digits(value) { return String(value || '').replace(/\D/g, ''); }
function whatsappNumber(phone) {
  const d = digits(phone);
  if (d.startsWith('55') && d.length >= 12) return d;
  if (d.length >= 10) return '55' + d;
  return d;
}
function mapsUrl(address) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address); }
function wazeUrl(address) { return 'https://waze.com/ul?q=' + encodeURIComponent(address) + '&navigate=yes'; }
function fullAddress(o) {
  const base = o.customer.endereco || '';
  return o.customer.complemento ? base + ' - ' + o.customer.complemento : base;
}
function deliveryState(o) {
  if (o.status === 'cancelado') return 'cancelado';
  const d = o.delivery || {};
  if (d.status === 'entregue' || o.status === 'entregue') return 'entregue';
  if (d.status === 'rota') return 'rota';
  if (d.status === 'aceito') return 'aceito';
  if (o.status === 'pronto') return 'disponivel';
  return 'aguardando';
}
function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}
function minutesSince(iso) { return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)); }
function elapsedLabel(minutes) {
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h + 'h' + String(m).padStart(2, '0');
}
function setConnection(state, text) {
  $('#connPill').dataset.state = state;
  $('#connText').textContent = text;
}

function showToast(message, type, action) {
  type = type || 'success';
  const icons = { success: '✅', error: '⚠️', warn: '🍔', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  let html = '<span class="toast-icon">' + (icons[type] || '🔔') + '</span>';
  html += '<span class="toast-text">' + escapeHtml(message) + '</span>';
  if (action) {
    html += '<button class="toast-action" type="button">' + escapeHtml(action.label) + '</button>';
  }
  toast.innerHTML = html;
  if (action) {
    toast.querySelector('.toast-action').addEventListener('click', () => {
      action.onClick();
      toast.remove();
    });
  }
  $('#toastStack').appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    setTimeout(() => toast.remove(), 250);
  }, action ? 8000 : 4200);
}

async function api(path, options) {
  options = options || {};
  const headers = Object.assign(
    { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    options.headers || {}
  );
  const response = await fetch(path, Object.assign({}, options, { headers }));
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    logout(false);
    throw new Error('Sessão expirada. Entre novamente.');
  }
  if (!response.ok) {
    throw new Error(data.error || 'Erro de comunicação com o servidor.');
  }
  return data;
}

async function loadOrders() {
  const data = await api('/api/delivery/orders');
  orders = new Map(data.orders.map((o) => [o.id, o]));
  render();
}

async function login(pin, name) {
  const btn = $('#loginBtn');
  const errorEl = $('#loginError');
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  errorEl.textContent = '';
  try {
    const response = await fetch('/api/delivery/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, name })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'PIN incorreto.');
    token = data.token;
    driverName = data.driver || name || 'Entregador';
    sessionStorage.setItem('jokers_delivery_token', token);
    localStorage.setItem('jokers_delivery_name', driverName);
    $('#driverLabel').textContent = driverName;
    initAudio();
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
    const card = $('.login-card');
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 450);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar nas entregas';
  }
}

async function enterApp() {
  $('#loginScreen').hidden = true;
  $('#appShell').hidden = false;
  $('#driverLabel').textContent = driverName || 'Entregador';
  setConnection('reconnecting', 'Conectando');
  await loadOrders();
  connectEvents();
  startTimers();
  updateSoundButton();
}

function logout(clear) {
  if (clear === undefined) clear = true;
  if (eventSource) eventSource.close();
  eventSource = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  orders.clear();
  closeDrawer();
  if (clear) {
    sessionStorage.removeItem('jokers_delivery_token');
    token = '';
  }
  $('#appShell').hidden = true;
  $('#loginScreen').hidden = false;
  $('#pinInput').value = '';
  $('#pinInput').focus();
}

function connectEvents() {
  if (eventSource) eventSource.close();
  setConnection('reconnecting', 'Conectando');
  eventSource = new EventSource('/api/events?token=' + encodeURIComponent(token));
  eventSource.addEventListener('hello', () => {
    setConnection('online', 'Ao vivo');
    stopPolling();
  });
  eventSource.addEventListener('order', (event) => {
    const payload = JSON.parse(event.data);
    const order = payload.order;
    const previous = orders.get(order.id);
    const prevState = previous ? deliveryState(previous) : null;
    const newState = deliveryState(order);
    orders.set(order.id, order);
    render();
    if (currentDrawerId === order.id) renderDrawer(order);
    if (payload.type === 'new') {
      showToast('Novo pedido #' + order.numero + ' entrou na fila', 'info');
    }
    if (newState === 'disponivel' && prevState !== 'disponivel') {
      playAlertSound();
      showToast('Pedido #' + order.numero + ' pronto para entrega!', 'warn', {
        label: 'Ver rota',
        onClick: () => openDrawer(order.id)
      });
      setTimeout(() => {
        const card = document.querySelector('[data-order-id="' + order.id + '"]');
        if (card) card.classList.add('flash');
      }, 50);
    }
  });
  eventSource.addEventListener('delivery', (event) => {
    const payload = JSON.parse(event.data);
    orders.set(payload.order.id, payload.order);
    render();
    if (currentDrawerId === payload.order.id) renderDrawer(payload.order);
  });
  eventSource.onerror = () => {
    setConnection('reconnecting', 'Reconectando');
    startPolling();
  };
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    loadOrders().catch(() => setConnection('offline', 'Offline'));
  }, 12000);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function initAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (err) {
    audioCtx = null;
  }
}

function playAlertSound() {
  if (!soundOn) return;
  if (!audioCtx) initAudio();
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const now = audioCtx.currentTime;
  const notes = [660, 880, 1175];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const start = now + i * 0.13;
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.32);
  });
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

function updateSoundButton() {
  $('#soundBtn').classList.toggle('muted', !soundOn);
  $('#soundLabel').textContent = soundOn ? 'Som ligado' : 'Som desligado';
}

function matchesSearch(o) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return true;
  const parts = [
    o.numero, o.customer.nome, o.customer.telefone,
    o.customer.endereco, o.customer.complemento,
    o.delivery ? o.delivery.driver : ''
  ];
  o.items.forEach((i) => parts.push(i.nome));
  return parts.join(' ').toLowerCase().includes(query);
}

function sortOrders(list) {
  const copy = list.slice();
  if (sortMode === 'recentes') {
    copy.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (sortMode === 'endereco') {
    copy.sort((a, b) => fullAddress(a).localeCompare(fullAddress(b), 'pt-BR'));
  } else if (sortMode === 'valor') {
    copy.sort((a, b) => b.totals.total - a.totals.total);
  } else {
    copy.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }
  return copy;
}

function getFiltered() {
  return Array.from(orders.values()).filter((o) => {
    const state = deliveryState(o);
    if (!matchesSearch(o)) return false;
    if (filterStatus === 'todos') return true;
    if (filterStatus === 'minhas') return state === 'aceito' || state === 'rota';
    return state === filterStatus;
  });
}

function cardActionsFor(state) {
  if (state === 'disponivel') {
    return '<button class="action-btn primary" data-action="accept">Aceitar entrega</button>';
  }
  if (state === 'aceito') {
    return '<button class="action-btn route" data-action="start">Iniciar rota</button>' +
           '<button class="action-btn cancel" data-action="release">Liberar</button>';
  }
  if (state === 'rota') {
    return '<button class="action-btn done" data-action="deliver">Confirmar entrega</button>';
  }
  if (state === 'aguardando') {
    return '<button class="action-btn ghost" disabled>Aguardando cozinha</button>';
  }
  return '<button class="action-btn ghost" data-action="details">Ver detalhes</button>';
}

function cardHtml(o) {
  const state = deliveryState(o);
  const minutes = minutesSince(o.createdAt);
  const active = ['disponivel', 'aceito', 'rota'].includes(state);
  let timeClass = '';
  if (active && minutes >= 35) timeClass = 'danger';
  else if (active && minutes >= 20) timeClass = 'warn';
  const address = fullAddress(o);
  const isCash = o.payment.metodo === 'Dinheiro';
  const itemCount = o.items.reduce((sum, i) => sum + i.qtd, 0);
  let nav = '';
  if (state !== 'cancelado') {
    nav += '<div class="quick-nav">';
    nav += '<a class="nav-link-btn" href="' + mapsUrl(address) + '" target="_blank" rel="noopener noreferrer" title="Google Maps" onclick="event.stopPropagation()">🗺️</a>';
    nav += '<a class="nav-link-btn" href="' + wazeUrl(address) + '" target="_blank" rel="noopener noreferrer" title="Waze" onclick="event.stopPropagation()">🧭</a>';
    nav += '<a class="nav-link-btn" href="tel:' + digits(o.customer.telefone) + '" title="Ligar" onclick="event.stopPropagation()">📞</a>';
    nav += '<a class="nav-link-btn" href="https://wa.me/' + whatsappNumber(o.customer.telefone) + '" target="_blank" rel="noopener noreferrer" title="WhatsApp" onclick="event.stopPropagation()">💬</a>';
    nav += '</div>';
  }
  let html = '<article class="delivery-card state-' + state + '" data-order-id="' + o.id + '" tabindex="0" role="button">';
  html += '<div class="card-top"><span class="order-num">#' + escapeHtml(o.numero) + '</span>';
  html += '<span class="state-badge">' + DELIVERY_LABEL[state] + '</span></div>';
  html += '<h3 class="customer-name">' + escapeHtml(o.customer.nome) + '</h3>';
  html += '<div class="card-meta"><span>📞 ' + escapeHtml(o.customer.telefone) + '</span>';
  html += '<span class="' + timeClass + '">🕐 ' + timeFmt.format(new Date(o.createdAt)) + ' • ' + elapsedLabel(minutes) + '</span>';
  if (o.delivery && o.delivery.driver) {
    html += '<span>🛵 ' + escapeHtml(o.delivery.driver) + '</span>';
  }
  html += '</div>';
  html += '<div class="address-block"><div class="address-label">📍 Endereço de entrega</div>';
  html += '<div class="address-text">' + escapeHtml(o.customer.endereco) + '</div>';
  if (o.customer.complemento) {
    html += '<div class="address-comp">' + escapeHtml(o.customer.complemento) + '</div>';
  }
  html += '</div>';
  html += '<div class="payment-block ' + (isCash ? 'cash' : '') + '"><span>💳 ' + escapeHtml(o.payment.metodo) + '</span>';
  if (isCash && o.payment.troco) {
    html += '<span>• Troco para ' + escapeHtml(o.payment.troco) + '</span>';
  }
  html += '</div>';
  html += '<div class="card-total"><span>' + money.format(o.totals.total) + '</span> • ' + itemCount + (itemCount === 1 ? ' item' : ' itens') + '</div>';
  html += nav;
  html += '<div class="card-actions">' + cardActionsFor(state) + '</div>';
  html += '</article>';
  return html;
}

function emptyColumn(title, text) {
  return '<div class="empty-col">' +
    '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.4">' +
    '<path d="M3 7h18M3 12h18M3 17h10"/></svg>' +
    '<p><strong>' + title + '</strong><br>' + text + '</p></div>';
}

function render() {
  const all = Array.from(orders.values());
  const filtered = getFiltered();
  const groups = {
    disponivel: sortOrders(filtered.filter((o) => deliveryState(o) === 'disponivel')),
    minhas: sortOrders(filtered.filter((o) => {
      const s = deliveryState(o);
      return s === 'aceito' || s === 'rota';
    })),
    aguardando: sortOrders(filtered.filter((o) => deliveryState(o) === 'aguardando')),
    entregue: sortOrders(filtered.filter((o) => deliveryState(o) === 'entregue')).slice(0, 30),
    cancelado: sortOrders(filtered.filter((o) => deliveryState(o) === 'cancelado')).slice(0, 20)
  };
  $('#cardsAvailable').innerHTML = groups.disponivel.length ? groups.disponivel.map(cardHtml).join('') : emptyColumn('Nenhuma entrega disponível', 'Pedidos prontos aparecem aqui');
  $('#cardsMine').innerHTML = groups.minhas.length ? groups.minhas.map(cardHtml).join('') : emptyColumn('Nenhuma entrega com você', 'Aceite uma entrega disponível');
  $('#cardsWait').innerHTML = groups.aguardando.length ? groups.aguardando.map(cardHtml).join('') : emptyColumn('Nada na cozinha', 'Novos pedidos aparecem aqui');
  $('#cardsDone').innerHTML = groups.entregue.length ? groups.entregue.map(cardHtml).join('') : emptyColumn('Nenhuma entregue', 'Entregas finalizadas ficam aqui');
  $('#cardsCancel').innerHTML = groups.cancelado.length ? groups.cancelado.map(cardHtml).join('') : emptyColumn('Nenhum cancelado', 'Pedidos cancelados aparecem aqui');
  $('#countAvailable').textContent = groups.disponivel.length;
  $('#countMine').textContent = groups.minhas.length;
  $('#countWait').textContent = groups.aguardando.length;
  $('#countDone').textContent = groups.entregue.length;
  $('#countCancel').textContent = groups.cancelado.length;
  const today = all.filter((o) => isToday(o.createdAt));
  $('#statAvailable').textContent = today.filter((o) => deliveryState(o) === 'disponivel').length;
  $('#statMine').textContent = today.filter((o) => {
    const s = deliveryState(o);
    return s === 'aceito' || s === 'rota';
  }).length;
  $('#statRoute').textContent = today.filter((o) => deliveryState(o) === 'rota').length;
  $('#statDone').textContent = today.filter((o) => deliveryState(o) === 'entregue').length;
  const durations = [];
  today.forEach((o) => {
    if (o.delivery && o.delivery.pickedUpAt && o.delivery.deliveredAt) {
      const value = (new Date(o.delivery.deliveredAt) - new Date(o.delivery.pickedUpAt)) / 60000;
      if (Number.isFinite(value)) durations.push(value);
    }
  });
  $('#statAvg').textContent = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) + 'm' : '—';
  $$('.board-col').forEach((col) => {
    const name = col.dataset.col;
    let visible = true;
    if (filterStatus !== 'todos') visible = name === filterStatus;
    col.classList.toggle('hidden', !visible);
  });
}

function applyLocalDelivery(o, target, driver) {
  const now = new Date().toISOString();
  const next = JSON.parse(JSON.stringify(o));
  next.delivery = next.delivery || {};
  next.delivery.status = target;
  if (target === 'aguardando') {
    next.delivery.driver = null;
    next.delivery.acceptedAt = null;
    next.delivery.pickedUpAt = null;
    next.delivery.deliveredAt = null;
    if (next.status === 'entregue') next.status = 'pronto';
  } else if (target === 'aceito') {
    next.delivery.driver = driver;
    next.delivery.acceptedAt = now;
    next.delivery.pickedUpAt = null;
    next.delivery.deliveredAt = null;
  } else if (target === 'rota') {
    next.delivery.driver = driver;
    next.delivery.acceptedAt = next.delivery.acceptedAt || now;
    next.delivery.pickedUpAt = now;
    next.delivery.deliveredAt = null;
  } else if (target === 'entregue') {
    next.delivery.driver = driver;
    next.delivery.deliveredAt = now;
    next.status = 'entregue';
  }
  return next;
}

async function changeDelivery(id, action, options) {
  options = options || {};
  const order = orders.get(id);
  if (!order) return;
  const previous = JSON.parse(JSON.stringify(order));
  const targetMap = {
    accept: 'aceito',
    start: 'rota',
    deliver: 'entregue',
    release: 'aguardando',
    revert: options.to
  };
  const target = targetMap[action];
  if (!target) return;
  const optimistic = applyLocalDelivery(order, target, driverName || 'Entregador');
  orders.set(id, optimistic);
  render();
  if (currentDrawerId === id) renderDrawer(optimistic);
  try {
    const body = action === 'revert' ? { action: action, to: options.to } : { action: action };
    const data = await api('/api/delivery/orders/' + id, {
      method: 'PATCH',
      body: JSON.stringify(body)
    });
    orders.set(id, data.order);
    render();
    if (currentDrawerId === id) renderDrawer(data.order);
    if (!options.silent) {
      const messages = {
        accept: 'Entrega #' + order.numero + ' aceita',
        start: 'Rota do pedido #' + order.numero + ' iniciada',
        deliver: 'Pedido #' + order.numero + ' entregue!',
        release: 'Entrega #' + order.numero + ' liberada'
      };
      const undoMap = { accept: 'aguardando', start: 'aceito', deliver: 'rota', release: 'aceito' };
      showToast(messages[action] || 'Entrega atualizada', action === 'deliver' ? 'success' : 'info', {
        label: 'Desfazer',
        onClick: () => changeDelivery(id, 'revert', { to: undoMap[action], silent: true })
      });
    }
  } catch (err) {
    orders.set(id, previous);
    render();
    if (currentDrawerId === id) renderDrawer(previous);
    showToast(err.message, 'error');
  }
}

function handleAction(id, action) {
  if (action === 'details') return openDrawer(id);
  if (['accept', 'start', 'deliver', 'release'].includes(action)) return changeDelivery(id, action);
}

function openDrawer(id) {
  const order = orders.get(id);
  if (!order) return;
  currentDrawerId = id;
  renderDrawer(order);
  $('#orderDrawer').classList.add('active');
  $('#drawerScrim').classList.add('active');
  $('#orderDrawer').setAttribute('aria-hidden', 'false');
  document.body.classList.add('locked');
}

function closeDrawer() {
  $('#orderDrawer').classList.remove('active');
  $('#drawerScrim').classList.remove('active');
  $('#orderDrawer').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('locked');
  currentDrawerId = null;
}

function drawerActionsFor(state) {
  if (state === 'disponivel') {
    return '<button class="action-btn primary" data-drawer-action="accept">Aceitar entrega</button>';
  }
  if (state === 'aceito') {
    return '<button class="action-btn route" data-drawer-action="start">Iniciar rota</button>' +
           '<button class="action-btn cancel" data-drawer-action="release">Liberar entrega</button>';
  }
  if (state === 'rota') {
    return '<button class="action-btn done" data-drawer-action="deliver">Confirmar entrega</button>';
  }
  return '';
}

function renderDrawer(o) {
  $('#drawerTitle').textContent = '#' + o.numero;
  const state = deliveryState(o);
  const address = fullAddress(o);
  const isCash = o.payment.metodo === 'Dinheiro';
  let itemsHtml = '';
  o.items.forEach((item) => {
    itemsHtml += '<div class="detail-item">';
    itemsHtml += '<div class="detail-item-head"><strong>' + item.qtd + '× ' + escapeHtml(item.nome) + '</strong>';
    itemsHtml += '<span>' + money.format(item.preco * item.qtd) + '</span></div>';
    if (item.adicionais && item.adicionais.length) {
      itemsHtml += '<div class="detail-addons">';
      item.adicionais.forEach((a) => {
        itemsHtml += '<span class="detail-addon">+ ' + escapeHtml(a.nome) + ' (' + money.format(a.preco) + ')</span>';
      });
      itemsHtml += '</div>';
    }
    if (item.observacoes) {
      itemsHtml += '<div class="detail-obs">📝 ' + escapeHtml(item.observacoes) + '</div>';
    }
    itemsHtml += '</div>';
  });
  const timeline = [{ at: o.createdAt, label: 'Pedido criado' }];
  if (o.delivery && o.delivery.acceptedAt) {
    timeline.push({ at: o.delivery.acceptedAt, label: 'Aceita por ' + (o.delivery.driver || 'entregador') });
  }
  if (o.delivery && o.delivery.pickedUpAt) {
    timeline.push({ at: o.delivery.pickedUpAt, label: 'Saiu para entrega' });
  }
  if (o.delivery && o.delivery.deliveredAt) {
    timeline.push({ at: o.delivery.deliveredAt, label: 'Entregue ao cliente' });
  }
  timeline.sort((a, b) => new Date(a.at) - new Date(b.at));
  let timelineHtml = '';
  timeline.forEach((t) => {
    timelineHtml += '<div class="timeline-item"><span class="timeline-dot"></span>';
    timelineHtml += '<div class="timeline-content"><strong>' + timeFmt.format(new Date(t.at)) + '</strong> — ' + escapeHtml(t.label) + '</div></div>';
  });
  const deliveryText = o.totals.deliveryFee === null ? escapeHtml(o.totals.deliveryFeeText || 'A combinar') : money.format(o.totals.deliveryFee);
  let html = '';
  html += '<section class="detail-section"><h3>📍 Rota e contato</h3><div class="detail-grid">';
  html += '<div class="detail-box highlight full"><span>Endereço completo</span><strong>' + escapeHtml(address) + '</strong></div>';
  html += '<div class="detail-box"><span>Cliente</span><strong>' + escapeHtml(o.customer.nome) + '</strong></div>';
  html += '<div class="detail-box"><span>Telefone</span><strong>' + escapeHtml(o.customer.telefone) + '</strong></div>';
  html += '</div><div class="detail-nav">';
  html += '<a href="' + mapsUrl(address) + '" target="_blank" rel="noopener noreferrer">🗺️ Google Maps</a>';
  html += '<a class="waze" href="' + wazeUrl(address) + '" target="_blank" rel="noopener noreferrer">🧭 Waze</a>';
  html += '<a href="tel:' + digits(o.customer.telefone) + '">📞 Ligar</a>';
  html += '<a class="whats" href="https://wa.me/' + whatsappNumber(o.customer.telefone) + '" target="_blank" rel="noopener noreferrer">💬 WhatsApp</a>';
  html += '</div></section>';
  html += '<section class="detail-section"><h3>💳 Pagamento na entrega</h3><div class="detail-grid">';
  html += '<div class="detail-box ' + (isCash ? 'cash' : '') + '"><span>Forma</span><strong>' + escapeHtml(o.payment.metodo) + '</strong></div>';
  html += '<div class="detail-box ' + (isCash ? 'cash' : '') + '"><span>Troco</span><strong>' + (isCash && o.payment.troco ? escapeHtml(o.payment.troco) : 'Não precisa') + '</strong></div>';
  html += '<div class="detail-box full"><span>Total do pedido</span><strong>' + money.format(o.totals.total) + '</strong></div>';
  html += '</div></section>';
  html += '<section class="detail-section"><h3>🍔 Conteúdo do pedido</h3>' + itemsHtml + '</section>';
  if (o.notes) {
    html += '<section class="detail-section"><h3>📝 Observações gerais</h3>';
    html += '<div class="detail-note">' + escapeHtml(o.notes) + '</div></section>';
  }
  html += '<section class="detail-section"><h3>💰 Valores</h3><div class="detail-totals">';
  html += '<div class="detail-row"><span>Subtotal</span><strong>' + money.format(o.totals.subtotal) + '</strong></div>';
  html += '<div class="detail-row"><span>Entrega</span><strong>' + deliveryText + '</strong></div>';
  html += '<div class="detail-row total"><span>Total</span><strong>' + money.format(o.totals.total) + '</strong></div>';
  html += '</div></section>';
  html += '<section class="detail-section"><h3>🕐 Linha do tempo</h3><div class="timeline">' + timelineHtml + '</div></section>';
  const actions = drawerActionsFor(state);
  if (actions) html += '<div class="drawer-actions">' + actions + '</div>';
  $('#drawerBody').innerHTML = html;
}

function startTimers() {
  if (timersStarted) return;
  timersStarted = true;
  setInterval(() => {
    const now = new Date();
    $('#clockText').textContent = dateFmt.format(now) + ' • ' + now.toLocaleTimeString('pt-BR');
  }, 1000);
  setInterval(() => {
    if (!document.hidden && token) render();
  }, 30000);
}

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  login($('#pinInput').value.trim(), $('#driverName').value.trim());
});
$('#logoutBtn').addEventListener('click', () => logout(true));
$('#refreshBtn').addEventListener('click', async () => {
  try {
    await loadOrders();
    showToast('Entregas atualizadas', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
});
$('#soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('jokers_delivery_sound', soundOn ? 'on' : 'off');
  updateSoundButton();
  if (soundOn) {
    initAudio();
    playAlertSound();
  }
});
$('#searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  render();
});
$('#sortSelect').addEventListener('change', (e) => {
  sortMode = e.target.value;
  render();
});
$('#statusChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filterStatus = chip.dataset.filter;
  $$('.chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  render();
});
$('#board').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  const card = e.target.closest('[data-order-id]');
  if (!card) return;
  const id = card.dataset.orderId;
  if (btn) {
    e.stopPropagation();
    handleAction(id, btn.dataset.action);
    return;
  }
  openDrawer(id);
});
$('#board').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-order-id]')) {
    openDrawer(e.target.dataset.orderId);
  }
});
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerScrim').addEventListener('click', closeDrawer);
$('#drawerBody').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-drawer-action]');
  if (!btn || !currentDrawerId) return;
  handleAction(currentDrawerId, btn.dataset.drawerAction);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
  const tag = document.activeElement.tagName;
  if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
    e.preventDefault();
    $('#searchInput').focus();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) loadOrders().catch(() => {});
});

(async function autoLogin() {
  $('#driverName').value = driverName;
  if (!token) {
    $('#pinInput').focus();
    return;
  }
  try {
    await enterApp();
  } catch (err) {
    logout(false);
  }
})();