'use strict';

// `window.hub` vem do preload (preload-shell.js).
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  config: null,
  events: [],
  runtime: {},
  plugins: [],
  maximized: null, // panelId expandido na aba ativa
  modalOpen: false,
  unread: new Set(), // abas com evento novo não visto
};

const ALIVE_MS = 2 * 60 * 1000;
const SUMMARY_LABELS = { 0: 'Desligado', 15: 'A cada 15 min', 30: 'A cada 30 min', 60: 'A cada 1 hora', 120: 'A cada 2 horas', 360: 'A cada 6 horas', 720: 'A cada 12 horas' };

// ---------- utilidades ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pluginFor(url) {
  const host = hostOf(url);
  return state.plugins.find((p) => p.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
}

function hhmm(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function activeTab() {
  return state.config.tabs.find((t) => t.id === state.config.activeTabId) || state.config.tabs[0];
}

async function commit(mutate) {
  const next = structuredClone(state.config);
  mutate(next);
  state.config = await hub.setConfig(next);
  render();
}

// ---------- layout das telas (WebContentsView fica sobre .cell-body) ----------

let layoutFrame = 0;
function scheduleLayout() {
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(sendLayout);
}

function sendLayout() {
  const rects = {};
  if (!state.modalOpen) {
    for (const body of document.querySelectorAll('.cell-body[data-live="1"]')) {
      const r = body.getBoundingClientRect();
      rects[body.dataset.panel] = { x: r.left, y: r.top, width: r.width, height: r.height };
    }
  }
  hub.setLayout(rects);
}

new ResizeObserver(scheduleLayout).observe(document.getElementById('grid'));
window.addEventListener('resize', scheduleLayout);

// ---------- render ----------

function render() {
  document.body.classList.toggle('feed-closed', !state.config.feedOpen);
  renderTabs();
  renderBanner();
  renderGrid();
  renderFeed();
  scheduleLayout();
}

function renderTabs() {
  const nav = $('#tabs');
  const active = activeTab();
  nav.innerHTML =
    state.config.tabs
      .map(
        (t) => `<div class="tab ${t.id === active.id ? 'active' : ''}" data-tab="${t.id}" title="Clique duplo para renomear">
          <span>${esc(t.name)}</span>
          ${state.unread.has(t.id) && t.id !== active.id ? '<span class="dot">●</span>' : ''}
          ${state.config.tabs.length > 1 ? `<button class="close" data-close="${t.id}" title="Fechar aba">×</button>` : ''}
        </div>`,
      )
      .join('') + '<button class="tab-add" id="tab-add" title="Nova aba">+</button>';
}

function renderBanner() {
  const banner = $('#banner');
  const warnings = [];
  for (const p of state.plugins) {
    if (!p.accountLimit) continue;
    const count = state.config.tabs.flatMap((t) => t.panels).filter((x) => x.url && pluginFor(x.url)?.id === p.id).length;
    if (count > p.accountLimit)
      warnings.push(
        `⚠️ ${count} telas do ${esc(p.name)} abertas. Os termos do jogo permitem no máximo ${p.accountLimit} contas por pessoa/aparelho (risco de banimento permanente).`,
      );
  }
  banner.hidden = !warnings.length;
  banner.innerHTML = warnings.join('<br>');
}

function statusClass(panelId) {
  const r = state.runtime[panelId];
  if (!r) return '';
  if (r.crashed) return 'crash';
  return r.lastSeen && Date.now() - r.lastSeen < ALIVE_MS ? 'on' : '';
}

function renderGrid() {
  const grid = $('#grid');
  const tab = activeTab();
  const maxed = tab.panels.find((p) => p.id === state.maximized);
  const panels = maxed ? [maxed] : tab.panels;
  grid.classList.toggle('single', !!maxed);
  grid.innerHTML = panels
    .map((p) => {
      const r = state.runtime[p.id] || {};
      const plugin = p.url ? pluginFor(p.url) : null;
      const body = p.url
        ? `<div class="cell-body" data-panel="${p.id}" data-live="1"></div>`
        : `<div class="cell-body"><div class="empty">
             <span>Tela vazia</span>
             <div class="row">
               ${state.plugins.map((pl) => `<button class="btn" data-quick="${p.id}" data-url="${esc(pl.defaultUrl)}">${esc(pl.name)}</button>`).join('')}
               <button class="btn" data-edit="${p.id}">Outra URL…</button>
             </div>
           </div></div>`;
      return `<div class="cell" data-cell="${p.id}">
        <div class="cell-bar">
          <span class="status ${statusClass(p.id)}" title="${plugin ? 'Verde = jogo conectado' : 'Sem plugin para este site'}"></span>
          <span class="name">${esc(p.name)}</span>
          <span class="nick">${r.nick ? '· ' + esc(r.nick) : ''}</span>
          <span class="spacer"></span>
          ${p.url ? `<button data-reload="${p.id}" title="Recarregar">⟳</button>` : ''}
          <button data-edit="${p.id}" title="Editar nome/URL">✎</button>
          ${p.url ? `<button data-max="${p.id}" title="${maxed ? 'Voltar à grade' : 'Expandir'}">${maxed ? '⤡' : '⤢'}</button>` : ''}
        </div>
        ${body}
      </div>`;
    })
    .join('');
}

function eventTitle(e) {
  if (e.type === 'shiny') return `✨ ${esc(e.name)}${e.level != null ? ` Nv ${e.level}` : ''}`;
  return `🎁 ${esc(e.item)} ×${e.qty}`;
}

function eventLine(e) {
  const who = e.nick ? `${esc(e.panelName)} (${esc(e.nick)})` : esc(e.panelName);
  const dc = e.discord === 'ok' ? '<span class="dc ok" title="Enviado ao Discord">✓ Discord</span>'
    : e.discord === 'erro' ? `<span class="dc erro" title="${esc(e.discordError || '')}">✗ Discord</span>`
    : e.discord === 'pendente' ? '<span class="dc">… Discord</span>' : '';
  return `<li class="ev ${e.type}" data-ev="${e.id}">
    <div class="title">${eventTitle(e)}</div>
    <div class="meta"><span>${esc(e.tabName)} › ${who}</span><span>${hhmm(e.ts)}</span></div>
    <div class="meta"><span>${e.type === 'drop' ? (e.from === 'boss' ? 'Boss: ' : 'Hunt: ') + esc(e.source) : e.source === 'ovo' ? 'Chocado de ovo' : 'Capturado'}</span>${dc}</div>
  </li>`;
}

function renderFeed() {
  const list = $('#feed-list');
  list.innerHTML = state.events.length
    ? state.events.map(eventLine).join('')
    : '<li class="feed-empty">Nenhum evento ainda.<br>Shinies e drops raros das suas contas aparecem aqui.</li>';
}

// ---------- modais ----------

function openModal(html, onMount) {
  state.modalOpen = true;
  sendLayout(); // esconde as telas de jogo, que ficam por cima do HTML
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><div class="modal">${html}</div></div>`;
  const modal = $('.modal', root);
  $('.backdrop', root).addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  onMount?.(modal);
  modal.querySelector('input,select,button')?.focus();
}

function closeModal() {
  $('#modal-root').innerHTML = '';
  state.modalOpen = false;
  scheduleLayout();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.modalOpen) closeModal();
});

function promptModal({ title, fields, okLabel = 'Salvar', extra = '' }) {
  return new Promise((resolve) => {
    const inputs = fields
      .map((f) => `<label>${esc(f.label)}</label><input type="text" name="${f.name}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}">`)
      .join('');
    openModal(
      `<h2>${esc(title)}</h2><form>${inputs}${extra}<div class="msg erro"></div>
        <div class="actions"><button type="button" class="btn" data-cancel>Cancelar</button><button class="btn primary">${esc(okLabel)}</button></div></form>`,
      (modal) => {
        const form = $('form', modal);
        $('[data-cancel]', modal).onclick = () => {
          closeModal();
          resolve(null);
        };
        modal.querySelectorAll('[data-fill]').forEach((b) => {
          b.onclick = () => {
            form.elements[b.dataset.fill].value = b.dataset.value;
          };
        });
        form.onsubmit = (e) => {
          e.preventDefault();
          const values = Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value.trim()]));
          for (const f of fields) {
            const err = f.validate?.(values[f.name]);
            if (err) {
              $('.msg', modal).textContent = err;
              return;
            }
          }
          closeModal();
          resolve(values);
        };
      },
    );
  });
}

function confirmModal(title, text, okLabel = 'Confirmar') {
  return new Promise((resolve) => {
    openModal(
      `<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="actions"><button class="btn" data-no>Cancelar</button><button class="btn danger" data-yes>${esc(okLabel)}</button></div>`,
      (modal) => {
        $('[data-no]', modal).onclick = () => {
          closeModal();
          resolve(false);
        };
        $('[data-yes]', modal).onclick = () => {
          closeModal();
          resolve(true);
        };
      },
    );
  });
}

const validUrl = (v) => {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? null : 'A URL precisa começar com http:// ou https://';
  } catch {
    return 'URL inválida (ex.: https://pokeidle.io/app)';
  }
};

async function editPanel(panelId) {
  const tab = state.config.tabs.find((t) => t.panels.some((p) => p.id === panelId));
  const panel = tab.panels.find((p) => p.id === panelId);
  const quick = state.plugins
    .map((p) => `<button type="button" class="chip" data-fill="url" data-value="${esc(p.defaultUrl)}">${esc(p.name)}</button>`)
    .join(' ');
  const values = await promptModal({
    title: 'Editar tela',
    fields: [
      { name: 'name', label: 'Nome da tela', value: panel.name, validate: (v) => (v ? null : 'Dê um nome à tela.') },
      { name: 'url', label: 'Endereço do jogo (deixe vazio para fechar a tela)', value: panel.url, placeholder: 'https://…', validate: validUrl },
    ],
    extra: `<div class="row" style="margin-top:6px">${quick}</div>
      <p class="hint">Cada tela tem sessão própria: o login de uma conta não interfere nas outras.</p>`,
  });
  if (!values) return;
  await commit((c) => {
    const p = c.tabs.flatMap((t) => t.panels).find((x) => x.id === panelId);
    p.name = values.name;
    p.url = values.url;
  });
}

async function renameTab(tabId) {
  const tab = state.config.tabs.find((t) => t.id === tabId);
  const values = await promptModal({
    title: 'Renomear aba',
    fields: [{ name: 'name', label: 'Nome da aba', value: tab.name, validate: (v) => (v ? null : 'Dê um nome à aba.') }],
  });
  if (!values) return;
  await commit((c) => {
    c.tabs.find((t) => t.id === tabId).name = values.name;
  });
}

async function addTab() {
  const quick = state.plugins
    .map((p) => `<button type="button" class="chip" data-fill="url" data-value="${esc(p.defaultUrl)}">${esc(p.name)}</button>`)
    .join(' ');
  const values = await promptModal({
    title: 'Nova aba',
    okLabel: 'Criar',
    fields: [
      { name: 'name', label: 'Nome da aba', value: `Aba ${state.config.tabs.length + 1}`, validate: (v) => (v ? null : 'Dê um nome à aba.') },
      { name: 'url', label: 'Abrir as 4 telas em (opcional)', value: '', placeholder: 'https://…', validate: validUrl },
    ],
    extra: `<div class="row" style="margin-top:6px">${quick}</div>
      <p class="hint">Você pode definir o endereço de cada tela depois, pelo ✎.</p>`,
  });
  if (!values) return;
  const offset = state.config.tabs.flatMap((t) => t.panels).length;
  await commit((c) => {
    const tab = {
      id: undefined,
      name: values.name,
      panels: [0, 1, 2, 3].map((i) => ({ name: `Conta ${offset + i + 1}`, url: values.url })),
    };
    c.tabs.push(tab);
  });
  // a nova aba é a última; ativa ela
  await commit((c) => {
    c.activeTabId = c.tabs[c.tabs.length - 1].id;
  });
}

async function closeTab(tabId) {
  const tab = state.config.tabs.find((t) => t.id === tabId);
  const ok = await confirmModal('Fechar aba', `Fechar "${tab.name}" e as 4 telas dela? Os logins dessas telas ficam salvos só enquanto a aba existir.`, 'Fechar aba');
  if (!ok) return;
  await commit((c) => {
    c.tabs = c.tabs.filter((t) => t.id !== tabId);
  });
}

function openSettings() {
  const c = state.config;
  const d = c.discord;
  const pluginSections = state.plugins
    .map((p) => {
      const items = p.rareItems
        .map(
          (i) => `<label class="check"><input type="checkbox" data-plugin="${p.id}" data-item="${i.id}" ${c.plugins[p.id]?.rareItems?.[i.id] ? 'checked' : ''}>
            ${esc(i.name)} <small>${esc(i.where)}</small></label>`,
        )
        .join('');
      return `<h3>${esc(p.name)} — drops raros avisados</h3>${items}`;
    })
    .join('');
  const options = Object.entries(SUMMARY_LABELS)
    .map(([v, l]) => `<option value="${v}" ${Number(v) === d.summaryMinutes ? 'selected' : ''}>${l}</option>`)
    .join('');

  openModal(
    `<h2>Configurações</h2>
     <h3>Discord</h3>
     <label>URL do webhook</label>
     <input type="url" id="s-webhook" value="${esc(d.webhookUrl)}" placeholder="https://discord.com/api/webhooks/…">
     <p class="hint">No Discord: Configurações do canal › Integrações › Webhooks › Novo webhook › Copiar URL.</p>
     <div class="row"><button class="btn" id="s-test">Testar webhook</button><button class="btn" id="s-summary">Enviar resumo agora</button></div>
     <div class="msg" id="s-msg"></div>
     <label class="check"><input type="checkbox" id="s-shiny" ${d.notifyShiny ? 'checked' : ''}> Avisar shinies capturados</label>
     <label class="check"><input type="checkbox" id="s-drops" ${d.notifyDrops ? 'checked' : ''}> Avisar drops raros</label>
     <label>Resumo automático</label>
     <select id="s-interval">${options}</select>
     ${pluginSections}
     <div class="actions"><button class="btn" data-cancel>Cancelar</button><button class="btn primary" id="s-save">Salvar</button></div>`,
    (modal) => {
      const msg = $('#s-msg', modal);
      const show = (res, okText) => {
        msg.className = `msg ${res.ok ? 'ok' : 'erro'}`;
        msg.textContent = res.ok ? okText : res.error;
      };
      $('[data-cancel]', modal).onclick = closeModal;
      $('#s-test', modal).onclick = async (e) => {
        e.target.disabled = true;
        show(await hub.testDiscord($('#s-webhook', modal).value.trim()), 'Mensagem de teste enviada! Confira o canal.');
        e.target.disabled = false;
      };
      $('#s-summary', modal).onclick = async (e) => {
        e.target.disabled = true;
        show(await hub.summaryNow(), 'Resumo enviado!');
        e.target.disabled = false;
      };
      $('#s-save', modal).onclick = async () => {
        const url = $('#s-webhook', modal).value.trim();
        if (url && !/^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/.test(url)) {
          show({ ok: false, error: 'URL de webhook inválida. Ela começa com https://discord.com/api/webhooks/' });
          return;
        }
        const checks = [...modal.querySelectorAll('[data-plugin]')];
        await commit((cfg) => {
          cfg.discord.webhookUrl = url;
          cfg.discord.notifyShiny = $('#s-shiny', modal).checked;
          cfg.discord.notifyDrops = $('#s-drops', modal).checked;
          cfg.discord.summaryMinutes = Number($('#s-interval', modal).value);
          for (const ch of checks) cfg.plugins[ch.dataset.plugin].rareItems[ch.dataset.item] = ch.checked;
        });
        closeModal();
      };
    },
  );
}

// ---------- interações ----------

$('#tabs').addEventListener('click', async (e) => {
  if (e.target.closest('#tab-add')) return addTab();
  const close = e.target.closest('[data-close]');
  if (close) return closeTab(close.dataset.close);
  const tab = e.target.closest('[data-tab]');
  if (tab && tab.dataset.tab !== state.config.activeTabId) {
    state.unread.delete(tab.dataset.tab);
    state.maximized = null;
    await commit((c) => {
      c.activeTabId = tab.dataset.tab;
    });
  }
});

$('#tabs').addEventListener('dblclick', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab && !e.target.closest('[data-close]')) renameTab(tab.dataset.tab);
});

$('#grid').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.reload) hub.reloadPanel(b.dataset.reload);
  else if (b.dataset.edit) editPanel(b.dataset.edit);
  else if (b.dataset.max) {
    state.maximized = state.maximized === b.dataset.max ? null : b.dataset.max;
    render();
  } else if (b.dataset.quick) {
    await commit((c) => {
      c.tabs.flatMap((t) => t.panels).find((p) => p.id === b.dataset.quick).url = b.dataset.url;
    });
  }
});

$('#feed-list').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-ev]');
  if (!li) return;
  const evt = state.events.find((x) => x.id === li.dataset.ev);
  if (!evt || !state.config.tabs.some((t) => t.id === evt.tabId)) return;
  state.unread.delete(evt.tabId);
  state.maximized = null;
  if (evt.tabId !== state.config.activeTabId) {
    await commit((c) => {
      c.activeTabId = evt.tabId;
    });
  }
  const cell = document.querySelector(`[data-cell="${evt.panelId}"]`);
  cell?.classList.remove('flash');
  void cell?.offsetWidth;
  cell?.classList.add('flash');
});

$('#btn-settings').onclick = openSettings;
$('#btn-feed').onclick = () => commit((c) => (c.feedOpen = !c.feedOpen));
$('#btn-clear').onclick = async () => {
  await hub.clearEvents();
  state.events = [];
  renderFeed();
};

// ---------- eventos vindos do processo principal ----------

hub.onEvent((evt) => {
  state.events.unshift(evt);
  if (state.events.length > 300) state.events.length = 300;
  if (evt.tabId !== state.config.activeTabId) {
    state.unread.add(evt.tabId);
    renderTabs();
  }
  renderFeed();
});

hub.onEventUpdate((patch) => {
  const evt = state.events.find((e) => e.id === patch.id);
  if (!evt) return;
  Object.assign(evt, patch);
  renderFeed();
});

hub.onRuntime(({ panelId, ...r }) => {
  state.runtime[panelId] = r;
  const cell = document.querySelector(`[data-cell="${panelId}"]`);
  if (!cell) return;
  const dot = $('.status', cell);
  dot.className = `status ${statusClass(panelId)}`;
  $('.nick', cell).textContent = r.nick ? '· ' + r.nick : '';
});

// status "verde" expira sozinho se a conta parar de receber mensagens
setInterval(() => {
  for (const cell of document.querySelectorAll('[data-cell]')) {
    $('.status', cell).className = `status ${statusClass(cell.dataset.cell)}`;
  }
}, 30000);

// ---------- atualização ----------

hub.onUpdateReady(({ version }) => {
  const banner = $('#update-banner');
  banner.innerHTML = `🚀 Nova versão ${esc(version)} pronta. <button class="btn primary" id="btn-update">Reiniciar e atualizar</button>
    <button class="link-btn" id="btn-update-later">depois</button>`;
  banner.hidden = false;
  $('#btn-update').onclick = () => hub.installUpdate();
  $('#btn-update-later').onclick = () => {
    banner.hidden = true;
    scheduleLayout();
  };
  scheduleLayout();
});

// ---------- início ----------

(async () => {
  const s = await hub.getState();
  Object.assign(state, { config: s.config, events: s.events, runtime: s.runtime, plugins: s.plugins });
  render();
  $('#brand').title = `IdleHub v${await hub.version()}`;
})();
