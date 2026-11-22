'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' });

const STATUS_LABEL = {
  novo: 'Novo',
  preparo: 'Em preparo',
  pronto: 'Pronto',
  entregue: 'Entregue',
  cancelado: 'Cancelado'
};

let token = sessionStorage.getItem('jokers_kitchen_token') || '';
let orders = new Map();
let filterStatus = 'todos';
let searchQuery = '';
let eventSource = null;
let pollTimer = null;
let soundOn = localStorage.getItem('jokers_kitchen_sound') !== 'off';
let audioCtx = null;
let currentDrawerId = null;
let timersStarted = false;

function escapeHtml(value) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => map[c]);
}

function setConnection(state, text) {
  $('#connPill').dataset.state = state;
  $('#connText').textContent = text;
}

function showToast(message, type, action) {
  type = type || 'success';
  const icons = { success: '✅', error: '⚠️', warn: '🔔', info: 'ℹ️' };
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
  const data = await api('/api/orders');
  orders = new Map(data.orders.map((o) => [o.id, o]));
  render();
}

async function login(pin) {
  const btn = $('#loginBtn');
  const errorEl = $('#loginError');
  btn.disabled = true;
  btn.textContent = 'Entrando...';
  errorEl.textContent = '';
  try {
    const response = await fetch('/api/kitchen/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'PIN incorreto.');
    token = data.token;
    sessionStorage.setItem('jokers_kitchen_token', token);
    initAudio();
    await enterApp();
  } catch (err) {
    errorEl.textContent = err.message;
    const card = $('.login-card');
    card.classList.add('shake');
    setTimeout(() => card.classList.remove('shake'), 450);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar na cozinha';
  }
}

async function enterApp() {
  $('#loginScreen').hidden = true;
  $('#appShell').hidden = false;
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
  if (clear) sessionStorage.removeItem('jokers_kitchen_token');
  token = '';
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
    orders.set(order.id, order);
    render();
    if (currentDrawerId === order.id) renderDrawer(order);
    if (payload.type === 'new') {
      playNewOrderSound();
      showToast('Novo pedido #' + order.numero + ' de ' + order.customer.nome, 'warn', {
        label: 'Ver pedido',
        onClick: () => openDrawer(order.id)
      });
      setTimeout(() => {
        const card = document.querySelector('[data-order-id="' + order.id + '"]');
        if (card) card.classList.add('flash');
      }, 50);
    }
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

function playNewOrderSound() {
  if (!soundOn) return;
  if (!audioCtx) initAudio();
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const now = audioCtx.currentTime;
  const notes = [880, 1175, 1568];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const start = now + i * 0.14;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.35);
  });
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

function updateSoundButton() {
  $('#soundBtn').classList.toggle('muted', !soundOn);
  $('#soundLabel').textContent = soundOn ? 'Som ligado' : 'Som desligado';
}

function isToday(iso) {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

function minutesSince(iso) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

function elapsedLabel(minutes) {
  if (minutes < 60) return minutes + ' min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h + 'h' + String(m).padStart(2, '0');
}

function getFilteredOrders() {
  const query = searchQuery.trim().toLowerCase();
  return Array.from(orders.values())
    .filter((o) => {
      if (filterStatus !== 'todos' && o.status !== filterStatus) return false;
      if (!query) return true;
      const parts = [o.numero, o.customer.nome, o.customer.telefone, o.customer.endereco];
      o.items.forEach((i) => parts.push(i.nome));
      return parts.join(' ').toLowerCase().includes(query);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function actionsFor(status) {
  if (status === 'novo') {
    return '<button class="action-btn primary" data-action="preparo">Iniciar preparo</button>' +
           '<button class="action-btn cancel" data-action="cancelado">Cancelar</button>';
  }
  if (status === 'preparo') {
    return '<button class="action-btn ready" data-action="pronto">Marcar pronto</button>' +
           '<button class="action-btn cancel" data-action="cancelado">Cancelar</button>';
  }
  if (status === 'pronto') {
    return '<button class="action-btn done" data-action="entregue">Marcar entregue</button>' +
           '<button class="action-btn ghost" data-action="print">Imprimir</button>';
  }
  return '<button class="action-btn ghost" data-action="print">Imprimir</button>';
}

function orderCard(o) {
  const minutes = minutesSince(o.createdAt);
  const active = ['novo', 'preparo', 'pronto'].includes(o.status);
  let elapsedClass = '';
  if (active && minutes >= 20) elapsedClass = 'danger';
  else if (active && minutes >= 10) elapsedClass = 'warn';
  let itemsHtml = '';
  o.items.slice(0, 4).forEach((item) => {
    itemsHtml += '<li><b>' + item.qtd + '×</b> ' + escapeHtml(item.nome);
    if (item.observacoes) {
      itemsHtml += '<em class="item-obs-badge">⚠ ' + escapeHtml(item.observacoes) + '</em>';
    }
    itemsHtml += '</li>';
  });
  if (o.items.length > 4) {
    itemsHtml += '<li style="color:var(--text-3)">+ ' + (o.items.length - 4) + ' item(ns)</li>';
  }
  let html = '<article class="order-card status-' + o.status + '" data-order-id="' + o.id + '" tabindex="0" role="button">';
  html += '<div class="card-top"><span class="order-num">#' + escapeHtml(o.numero) + '</span>';
  html += '<span class="elapsed ' + elapsedClass + '">' + elapsedLabel(minutes) + '</span></div>';
  html += '<h3 class="customer-name">' + escapeHtml(o.customer.nome) + '</h3>';
  html += '<div class="card-meta"><span>📞 ' + escapeHtml(o.customer.telefone) + '</span>';
  html += '<span>🕐 ' + timeFmt.format(new Date(o.createdAt)) + ' • ' + STATUS_LABEL[o.status] + '</span></div>';
  html += '<ul class="items-preview">' + itemsHtml + '</ul>';
  html += '<div class="card-total">' + money.format(o.totals.total) + ' • ' + escapeHtml(o.payment.metodo) + '</div>';
  html += '<div class="card-actions">' + actionsFor(o.status) + '</div>';
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
  const filtered = getFilteredOrders();
  const groups = {
    novo: filtered.filter((o) => o.status === 'novo'),
    preparo: filtered.filter((o) => o.status === 'preparo'),
    pronto: filtered.filter((o) => o.status === 'pronto'),
    final: filtered.filter((o) => o.status === 'entregue' || o.status === 'cancelado')
  };
  $('#cardsNew').innerHTML = groups.novo.length ? groups.novo.map(orderCard).join('') : emptyColumn('Nenhum pedido novo', 'Aguardando pedidos do site');
  $('#cardsPrep').innerHTML = groups.preparo.length ? groups.preparo.map(orderCard).join('') : emptyColumn('Nada em preparo', 'Os pedidos aceitos aparecem aqui');
  $('#cardsReady').innerHTML = groups.pronto.length ? groups.pronto.map(orderCard).join('') : emptyColumn('Nenhum pedido pronto', 'Pedidos finalizados aparecem aqui');
  $('#cardsFinal').innerHTML = groups.final.length ? groups.final.slice(0, 20).map(orderCard).join('') : emptyColumn('Nenhum finalizado', 'Entregues e cancelados ficam aqui');
  $('#countNew').textContent = groups.novo.length;
  $('#countPrep').textContent = groups.preparo.length;
  $('#countReady').textContent = groups.pronto.length;
  $('#countFinal').textContent = groups.final.length;
  const today = all.filter((o) => isToday(o.createdAt));
  $('#statNew').textContent = today.filter((o) => o.status === 'novo').length;
  $('#statPrep').textContent = today.filter((o) => o.status === 'preparo').length;
  $('#statReady').textContent = today.filter((o) => o.status === 'pronto').length;
  $('#statDone').textContent = today.filter((o) => o.status === 'entregue').length;
  const times = [];
  today.forEach((o) => {
    const hist = o.history || [];
    const ready = hist.find((h) => h.status === 'pronto');
    if (ready) {
      const value = (new Date(ready.at) - new Date(o.createdAt)) / 60000;
      if (Number.isFinite(value)) times.push(value);
    }
  });
  $('#statAvg').textContent = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) + 'm' : '—';
  $$('.board-col').forEach((col) => {
    const name = col.dataset.col;
    let visible = true;
    if (filterStatus !== 'todos') {
      visible = name === filterStatus || (name === 'final' && (filterStatus === 'entregue' || filterStatus === 'cancelado'));
    }
    col.classList.toggle('hidden', !visible);
  });
}

async function changeStatus(id, status, options) {
  options = options || {};
  const order = orders.get(id);
  if (!order) return;
  const previous = order.status;
  if (previous === status) return;
  const optimistic = Object.assign({}, order, { status, updatedAt: new Date().toISOString() });
  orders.set(id, optimistic);
  render();
  if (currentDrawerId === id) renderDrawer(optimistic);
  try {
    const data = await api('/api/orders/' + id + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ status })
    });
    orders.set(id, data.order);
    render();
    if (currentDrawerId === id) renderDrawer(data.order);
    if (!options.silent) {
      if (status === 'cancelado') {
        showToast('Pedido #' + order.numero + ' cancelado', 'error', {
          label: 'Desfazer',
          onClick: () => changeStatus(id, previous, { silent: true })
        });
      } else {
        showToast('Pedido #' + order.numero + ' → ' + STATUS_LABEL[status], 'success');
      }
    }
  } catch (err) {
    orders.set(id, order);
    render();
    if (currentDrawerId === id) renderDrawer(order);
    showToast(err.message, 'error');
  }
}

function handleAction(id, action) {
  if (action === 'print') return printOrder(id);
  if (STATUS_LABEL[action]) return changeStatus(id, action);
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

function drawerActionsFor(status) {
  if (status === 'novo') {
    return '<button class="action-btn primary" data-drawer-action="preparo">Iniciar preparo</button>' +
           '<button class="action-btn cancel" data-drawer-action="cancelado">Cancelar</button>';
  }
  if (status === 'preparo') {
    return '<button class="action-btn ready" data-drawer-action="pronto">Marcar pronto</button>' +
           '<button class="action-btn cancel" data-drawer-action="cancelado">Cancelar</button>';
  }
  if (status === 'pronto') {
    return '<button class="action-btn done" data-drawer-action="entregue">Marcar entregue</button>';
  }
  return '';
}

function renderDrawer(o) {
  $('#drawerTitle').textContent = '#' + o.numero;
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
      itemsHtml += '<div class="detail-obs"><strong>⚠ Observações do item</strong>' + escapeHtml(item.observacoes) + '</div>';
    }
    itemsHtml += '</div>';
  });
  const deliveryText = o.totals.deliveryFee === null ? escapeHtml(o.totals.deliveryFeeText || 'A combinar') : money.format(o.totals.deliveryFee);
  let historyHtml = '';
  (o.history || []).forEach((h) => {
    historyHtml += timeFmt.format(new Date(h.at)) + ' — ' + (STATUS_LABEL[h.status] || h.status) + '<br>';
  });
  let html = '';
  html += '<section class="detail-section"><h3>👤 Cliente</h3><div class="detail-grid">';
  html += '<div class="detail-box"><span>Nome</span><strong>' + escapeHtml(o.customer.nome) + '</strong></div>';
  html += '<div class="detail-box"><span>Telefone</span><strong>' + escapeHtml(o.customer.telefone) + '</strong></div>';
  html += '<div class="detail-box full"><span>Endereço</span><strong>' + escapeHtml(o.customer.endereco) + '</strong></div>';
  if (o.customer.complemento) {
    html += '<div class="detail-box full"><span>Complemento</span><strong>' + escapeHtml(o.customer.complemento) + '</strong></div>';
  }
  html += '</div></section>';
  html += '<section class="detail-section"><h3>🍔 Itens do pedido</h3>' + itemsHtml + '</section>';
  if (o.notes) {
    html += '<section class="detail-section"><h3>📝 Observações gerais</h3>';
    html += '<div class="detail-note">' + escapeHtml(o.notes) + '</div></section>';
  }
  html += '<section class="detail-section"><h3>💰 Pagamento e valores</h3><div class="detail-grid">';
  html += '<div class="detail-box"><span>Forma</span><strong>' + escapeHtml(o.payment.metodo) + '</strong></div>';
  html += '<div class="detail-box"><span>Troco</span><strong>' + (o.payment.troco ? escapeHtml(o.payment.troco) : 'Não precisa') + '</strong></div>';
  html += '</div><div class="detail-totals" style="margin-top:12px">';
  html += '<div class="detail-row"><span>Subtotal</span><strong>' + money.format(o.totals.subtotal) + '</strong></div>';
  html += '<div class="detail-row"><span>Entrega</span><strong>' + deliveryText + '</strong></div>';
  html += '<div class="detail-row total"><span>Total</span><strong>' + money.format(o.totals.total) + '</strong></div>';
  html += '</div></section>';
  html += '<section class="detail-section"><h3>🕐 Histórico</h3><div class="detail-note">' + historyHtml + '</div></section>';
  html += '<div class="drawer-actions">' + drawerActionsFor(o.status);
  html += '<button class="action-btn ghost" data-drawer-action="print">Imprimir pedido</button></div>';
  $('#drawerBody').innerHTML = html;
}

function printOrder(id) {
  const o = orders.get(id);
  if (!o) return;
  let items = '';
  o.items.forEach((item) => {
    items += '<div class="t-item"><div class="t-line"><b>' + item.qtd + 'x ' + escapeHtml(item.nome) + '</b>';
    items += '<span>' + money.format(item.preco * item.qtd) + '</span></div>';
    if (item.adicionais && item.adicionais.length) {
      items += '<div class="t-addon">' + item.adicionais.map((a) => '+ ' + escapeHtml(a.nome)).join('<br>') + '</div>';
    }
    if (item.observacoes) {
      items += '<div class="t-obs">OBS: ' + escapeHtml(item.observacoes) + '</div>';
    }
    items += '</div>';
  });
  const deliveryText = o.totals.deliveryFee === null ? escapeHtml(o.totals.deliveryFeeText || 'A combinar') : money.format(o.totals.deliveryFee);
  const css = '@page{size:80mm auto;margin:4mm}' +
    "body{font-family:'Courier New',monospace;width:72mm;margin:0 auto;color:#000;font-size:12px}" +
    'h1{text-align:center;font-size:18px;margin:0 0 4px}' +
    '.center{text-align:center}' +
    'hr{border:none;border-top:1px dashed #000;margin:8px 0}' +
    '.num{font-size:26px;font-weight:bold;text-align:center;margin:6px 0}' +
    '.t-item{margin-bottom:8px}' +
    '.t-line{display:flex;justify-content:space-between;gap:6px}' +
    '.t-addon{padding-left:10px;font-size:11px}' +
    '.t-obs{border:1px solid #000;padding:4px;margin-top:4px;font-weight:bold;font-size:11px}' +
    '.t-row{display:flex;justify-content:space-between}' +
    '.total{font-size:15px;font-weight:bold}';
  let body = '<h1>JOKER\'S BURGER</h1><div class="center">COZINHA</div>';
  body += '<div class="num">#' + escapeHtml(o.numero) + '</div>';
  body += '<div class="center">' + new Date(o.createdAt).toLocaleString('pt-BR') + '</div><hr>';
  body += '<b>CLIENTE:</b> ' + escapeHtml(o.customer.nome) + '<br>';
  body += '<b>TEL:</b> ' + escapeHtml(o.customer.telefone) + '<br>';
  body += '<b>END:</b> ' + escapeHtml(o.customer.endereco) + '<br>';
  if (o.customer.complemento) {
    body += '<b>COMP:</b> ' + escapeHtml(o.customer.complemento) + '<br>';
  }
  body += '<hr>' + items + '<hr>';
  if (o.notes) {
    body += '<b>OBS GERAL:</b> ' + escapeHtml(o.notes) + '<hr>';
  }
  body += '<div class="t-row"><span>Subtotal</span><span>' + money.format(o.totals.subtotal) + '</span></div>';
  body += '<div class="t-row"><span>Entrega</span><span>' + deliveryText + '</span></div>';
  body += '<div class="t-row total"><span>TOTAL</span><span>' + money.format(o.totals.total) + '</span></div><hr>';
  body += '<b>PAGAMENTO:</b> ' + escapeHtml(o.payment.metodo) + '<br>';
  if (o.payment.troco) {
    body += '<b>TROCO PARA:</b> ' + escapeHtml(o.payment.troco) + '<br>';
  }
  body += '<div class="center" style="margin-top:10px">*** JOKER\'S BURGER ***</div>';
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pedido ' + escapeHtml(o.numero) + '</title><style>' + css + '</style></head><body>' + body + '</body></html>';
  const win = window.open('', '_blank', 'width=420,height=700');
  if (!win) {
    showToast('Permita pop-ups para imprimir o pedido.', 'error');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 350);
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
  login($('#pinInput').value.trim());
});
$('#logoutBtn').addEventListener('click', () => logout(true));
$('#refreshBtn').addEventListener('click', async () => {
  try {
    await loadOrders();
    showToast('Pedidos atualizados', 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
});
$('#soundBtn').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('jokers_kitchen_sound', soundOn ? 'on' : 'off');
  updateSoundButton();
  if (soundOn) {
    initAudio();
    playNewOrderSound();
  }
});
$('#searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value;
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
  if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
    e.preventDefault();
    $('#searchInput').focus();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) loadOrders().catch(() => {});
});

(async function autoLogin() {
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