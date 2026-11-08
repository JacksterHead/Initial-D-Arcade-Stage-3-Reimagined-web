// The "Versus" panel: pairing by code, the lobby (car, course, ready, chat, records) and the in-race chip.
// It owns the WebRTC link (main thread only) and talks to the session in the game worker by postMessage:
//   worker -> here  mp-send {data, reliable}   mp-view {view}   mp-ended {reason}
//   here -> worker  mp-open  mp-link  mp-data  mp-do  mp-close  blocked
// All text shown to the player that came from the other side is inserted with textContent, never as HTML.
import { MpLink } from './mp-link.js';
import { COURSES, CAR_NAMES, directionLabel } from './mp-session.js';

const NAME_KEY = 'idas-web-name';

const css = `
#vsButton { position: fixed; z-index: 4; left: 8px; top: calc(env(safe-area-inset-top) + 6px); padding: 6px 14px; font-size: 13px; display: none;
  background: rgba(20,24,34,.62); border: 1px solid rgba(255,255,255,.35); letter-spacing: .06em; }
#vsButton.available { display: block; }
#vsButton.live { border-color: #5fe08a; color: #bff5cf; }
#stats { top: 44px !important; }
#versus { position: fixed; inset: 0; z-index: 7; display: none; align-items: center; justify-content: center; background: rgba(3,5,10,.82);
  font: 15px/1.4 system-ui, sans-serif; color: #e8ecf4; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
#versus.open { display: flex; }
#versus, #vsChip { touch-action: manipulation; -webkit-user-select: text; user-select: text; }
#versus button, #vsChip button { -webkit-user-select: none; user-select: none; }
#versus .card { width: min(560px, calc(100vw - 20px)); max-height: calc(100vh - 20px); max-height: calc(100dvh - 20px); overflow: auto; box-sizing: border-box;
  background: #0d1119; border: 1px solid #2a3350; border-radius: 12px; padding: 14px 16px 16px; -webkit-overflow-scrolling: touch; touch-action: pan-y; }
#versus header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
#versus h2 { font-size: 17px; margin: 0; letter-spacing: .08em; font-weight: 700; }
#versus h3 { font-size: 12px; margin: 14px 0 6px; letter-spacing: .1em; color: #8fa0c4; font-weight: 600; text-transform: uppercase; }
#versus p { margin: 6px 0; color: #b9c3d8; }
#versus p.note { font-size: 12px; color: #7d889b; }
#versus .status { color: #e8ecf4; min-height: 1.4em; }
#versus .status.bad { color: #ff9a9a; }
#versus button { font: inherit; padding: 10px 16px; min-height: 44px; border-radius: 8px; background: #2a62d6; color: #fff; border: 0; }
#versus button.alt { background: #262e44; }
#versus button.go { background: #1f9d55; }
#versus button:disabled { opacity: .45; }
#versus .x { min-height: 36px; padding: 4px 12px; background: #262e44; font-size: 18px; line-height: 1; }
#versus .row { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
#versus textarea, #versus input[type=text], #versus select { width: 100%; box-sizing: border-box; font: 14px ui-monospace, monospace; color: #e8ecf4; background: #060910;
  border: 1px solid #2a3350; border-radius: 6px; padding: 8px; }
#versus select { font-family: inherit; min-height: 40px; }
#versus textarea { height: 76px; resize: none; }
#versus label { display: block; font-size: 12px; color: #8fa0c4; margin: 8px 0 3px; }
#versus .players { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
#versus .player { border: 1px solid #2a3350; border-radius: 8px; padding: 8px 10px; min-width: 0; }
#versus .player b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#versus .player small { color: #8fa0c4; display: block; }
#versus .badge { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #262e44; color: #aab3c4; margin-top: 4px; }
#versus .badge.on { background: #1f9d55; color: #fff; }
#versus .chat { height: 110px; overflow: auto; background: #060910; border: 1px solid #2a3350; border-radius: 6px; padding: 6px 8px; font-size: 14px; }
#versus .chat div { overflow-wrap: anywhere; margin: 2px 0; }
#versus .chat .me b { color: #7fb0ff; } #versus .chat .them b { color: #ffcf7f; }
#versus form { display: flex; gap: 8px; margin-top: 8px; }
#versus form input { flex: 1; }
#versus .card.wide { width: min(900px, calc(100vw - 20px)); }
#versus .lobby-grid { display: block; }
@media (min-width: 720px) { #versus .lobby-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; align-items: start; } }
#versus .hist { font-size: 13px; color: #b9c3d8; }
#versus .hist div { padding: 3px 0; border-bottom: 1px solid #1b2236; }
#versus [hidden] { display: none !important; }
#vsChip { position: fixed; z-index: 6; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top) + 6px); display: none; gap: 8px; align-items: center;
  background: rgba(13,17,25,.82); border: 1px solid #2a3350; border-radius: 999px; padding: 4px 6px 4px 14px; color: #e8ecf4; font: 13px/1.2 system-ui, sans-serif; max-width: calc(100vw - 20px); }
#vsChip.on { display: flex; }
#vsChip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-height: 460px) { #versus .card { padding: 10px 14px 12px; } #versus textarea { height: 54px; } #versus h3 { margin: 10px 0 4px; } #versus .chat { height: 84px; } #versus button { min-height: 40px; padding: 8px 14px; } }
#vsChip button { font: inherit; font-size: 12px; padding: 6px 12px; min-height: 32px; border-radius: 999px; background: #8c2f3a; color: #fff; border: 0; }
`;

const el = (tag, props = {}, ...children) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const c of children) n.append(c);
  return n;
};
const fmtTime = (ticks) => {
  const t = Math.round(ticks / 60 * 10) / 10, m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

/**
 * @param {{worker: Worker, getBuildId: () => Promise<string>, container?: HTMLElement}} o
 */
export function initVersus({ worker, getBuildId, container = document.body }) {
  document.head.append(el('style', { textContent: css }));

  // ---- markup (built once; updates only touch text/values so typing and focus survive) ---------
  const $ = {};
  const field = (id, tag, props = {}, ...kids) => ($[id] = el(tag, { id, ...props }, ...kids));
  const section = (name, ...kids) => { const s = el('div', { className: 'sec' }, ...kids); s.dataset.s = name; $['s_' + name] = s; return s; };
  const row = (...kids) => el('div', { className: 'row' }, ...kids);
  const btn = (id, text, cls = '') => field(id, 'button', { type: 'button', textContent: text, className: cls });
  const p = (text, cls = '') => el('p', { textContent: text, className: cls });

  $.name = field('vsName', 'input', { type: 'text', maxLength: 24, autocomplete: 'off', spellcheck: false });
  $.name.value = safeGet(NAME_KEY) || `DRIVER${String(Math.floor(Math.random() * 90) + 10)}`;
  $.name.addEventListener('change', () => safeSet(NAME_KEY, $.name.value.trim()));

  const home = section('home',
    el('label', { textContent: 'Your name', htmlFor: 'vsName' }), $.name,
    row(btn('vsHost', 'Host a race'), btn('vsJoin', 'Join a race', 'alt')),
    p('Two players, one race. There is no server: the host creates a code, the other player sends back a reply code, and the two browsers connect directly. You need the same version of the game, and a network that allows direct connections.', 'note'),
    el('h3', { textContent: 'Your records' }), field('vsRecords', 'div', { className: 'hist' }));

  const hostSec = section('host',
    p('1. Send this code to the other player:'),
    field('vsHostCode', 'textarea', { readOnly: true, spellcheck: false }),
    row(btn('vsCopyHost', 'Copy', 'alt'), btn('vsShareHost', 'Share', 'alt')),
    p('2. Paste the reply code they send back:'),
    field('vsReply', 'textarea', { spellcheck: false, autocomplete: 'off', placeholder: 'Reply code' }),
    row(btn('vsConnect', 'Connect', 'go'), btn('vsHostCancel', 'Cancel', 'alt')),
    field('vsHostStatus', 'p', { className: 'status' }));

  const joinSec = section('join',
    p('1. Paste the code the host sent you:'),
    field('vsHostIn', 'textarea', { spellcheck: false, autocomplete: 'off', placeholder: 'Host code' }),
    row(btn('vsJoinGo', 'Join', 'go'), btn('vsJoinCancel', 'Cancel', 'alt')),
    field('vsReplyBox', 'div', {}, p('2. Send this reply code back to the host:'),
      field('vsReplyOut', 'textarea', { readOnly: true, spellcheck: false }), row(btn('vsCopyReply', 'Copy', 'alt'), btn('vsShareReply', 'Share', 'alt'))),
    field('vsJoinStatus', 'p', { className: 'status' }));
  $.vsReplyBox.hidden = true;

  const carSelect = (id) => field(id, 'select', {});
  const lobby = section('lobby',
    field('vsLobbyStatus', 'p', { className: 'status' }),
    el('div', { className: 'lobby-grid' }, el('div', {},
    el('div', { className: 'players' },
      el('div', { className: 'player' }, field('vsMeName', 'b', {}), field('vsMeRecord', 'small', {}), carSelect('vsCar'),
        field('vsAuto', 'select', {}, ...['Automatic', 'Manual'].map((t, i) => el('option', { value: String(i), textContent: t }))), field('vsMeBadge', 'span', { className: 'badge' })),
      el('div', { className: 'player' }, field('vsThemName', 'b', {}), field('vsThemRecord', 'small', {}), field('vsThemCar', 'small', {}), field('vsThemBadge', 'span', { className: 'badge' }))),
    el('h3', { textContent: 'Race' }),
    field('vsRulesHost', 'div', {},
      carSelect('vsCourse'),
      el('div', { className: 'row' }, field('vsReverse', 'select', {}), field('vsBoost', 'select', {}, ...['Boost on', 'Boost off'].map((t, i) => el('option', { value: String(i), textContent: t }))),
        field('vsCollide', 'select', {}, ...['Collisions on', 'Collisions off'].map((t, i) => el('option', { value: String(i), textContent: t }))))),
    field('vsRulesGuest', 'p', {}),
    row(btn('vsReady', 'I am ready', 'go'), btn('vsStart', 'Start race', 'go')),
    row(btn('vsLeave', 'Leave', 'alt'))),
    el('div', {},
    el('h3', { textContent: 'Chat' }),
    field('vsChat', 'div', { className: 'chat' }),
    field('vsSayForm', 'form', {}, field('vsSay', 'input', { type: 'text', maxLength: 160, autocomplete: 'off', placeholder: 'Message' }), btn('vsSend', 'Send', 'alt')),
    el('h3', { textContent: 'Recent races' }), field('vsHistory', 'div', { className: 'hist' }))));
  $.vsSend.type = 'submit';

  const lost = section('lost', field('vsLostText', 'p', { className: 'status bad' }), row(btn('vsLostLeave', 'Leave', 'alt')));
  const ended = section('ended', field('vsEndedText', 'p', { className: 'status' }), row(btn('vsEndedOk', 'OK')));

  const panel = el('div', { id: 'versus' }, el('div', { className: 'card', role: 'dialog', 'aria-label': 'Versus' },
    el('header', {}, el('h2', { textContent: 'VERSUS' }), field('vsClose', 'button', { type: 'button', className: 'x', textContent: '×', title: 'Close' })),
    home, hostSec, joinSec, lobby, lost, ended));
  const button = el('button', { id: 'vsButton', type: 'button', textContent: 'VERSUS' });
  const chip = el('div', { id: 'vsChip' }, el('span', { id: 'vsChipText' }), el('button', { id: 'vsChipLeave', type: 'button', textContent: 'Leave' }));
  container.append(button, panel, chip);
  const chipText = chip.firstChild;
  $.vsChipLeave = chip.lastChild;

  // ---- state -----------------------------------------------------------------------------------
  let link = null, screen = 'home', open = false, view = null, driving = true, ready = false, role = null, buildId = 'dev';
  let lastChat = -1, lastCarKey = '', lastRulesKey = '';

  const post = (m, t) => worker.postMessage(m, t ?? []);
  const doAction = (action, value) => post({ type: 'mp-do', action, value });
  const sessionLive = () => !!view && view.state !== 'closed';

  function show(name) {
    screen = name;
    panel.firstChild.classList.toggle('wide', name === 'lobby');
    panel.firstChild.scrollTop = 0;
    for (const s of panel.querySelectorAll('.sec')) s.hidden = s.dataset.s !== name;
    refreshChrome();
  }
  function setOpen(value) {
    open = value;
    panel.classList.toggle('open', open);
    post({ type: 'blocked', blocked: open });
    refreshChrome();
    if (open && screen === 'home') renderRecords();
  }
  function refreshChrome() {
    const racing = view && ['loading', 'countdown', 'racing', 'results'].includes(view.state);
    button.classList.toggle('available', ready && (!driving || sessionLive()) && !racing);
    button.classList.toggle('live', sessionLive());
    button.textContent = sessionLive() ? (view.state === 'lobby' ? 'VERSUS • LOBBY' : 'VERSUS •') : 'VERSUS';
    chip.classList.toggle('on', !!racing);
    if (racing) chipText.textContent = chipLabel();
  }
  function chipLabel() {
    const v = view;
    const who = `VS ${v.remoteName || 'opponent'}${v.ping >= 0 ? ` · ${v.ping} ms` : ''}`;
    if (v.state === 'results') return `${who} · ${v.result?.text ?? 'result'}${v.peerLeft ? ' · opponent left' : ''}`;
    return `${who} · ${v.state === 'racing' ? 'live' : v.state === 'countdown' ? 'starting' : 'loading'}`;
  }

  // ---- connection ------------------------------------------------------------------------------
  function endLink() { try { link?.close(); } catch { /* ignore */ } link = null; }
  function begin(which) {
    endLink();
    role = which;
    const name = $.name.value.trim() || 'DRIVER';
    safeSet(NAME_KEY, name);
    post({ type: 'mp-open', role, name, buildId });
    link = new MpLink({
      onState: (state, detail) => {
        if (link === null) return;
        const status = { gathering: 'Preparing your code…', code: role === 'host' ? 'Waiting for the reply code.' : 'Send the reply code to the host. The game connects as soon as they paste it.',
          connecting: 'Connecting…', open: 'Connected.', failed: detail || 'The connection failed.' }[state];
        (role === 'host' ? $.vsHostStatus : $.vsJoinStatus).textContent = status ?? '';
        (role === 'host' ? $.vsHostStatus : $.vsJoinStatus).classList.toggle('bad', state === 'failed');
        if (state === 'open' || state === 'failed') post({ type: 'mp-link', state, detail });
        if (state === 'failed' && !sessionLive()) { show('ended'); $.vsEndedText.textContent = detail || 'The connection failed.'; }
      },
      onMessage: (data) => post({ type: 'mp-data', data }, data instanceof ArrayBuffer ? [data] : []),
    });
  }
  async function startHost() {
    begin('host');
    show('host'); $.vsHostCode.value = ''; $.vsReply.value = ''; $.vsConnect.disabled = true;
    try {
      const code = await link.host();
      $.vsHostCode.value = code; $.vsConnect.disabled = false;
    } catch (e) { fault(`Could not create a code: ${e.message}`); }
  }
  async function startJoin() {
    begin('guest');
    show('join'); $.vsHostIn.value = ''; $.vsReplyOut.value = ''; $.vsReplyBox.hidden = true; $.vsJoinStatus.textContent = 'Paste the host code, then press Join.'; $.vsJoinStatus.classList.remove('bad');
  }
  function fault(text) {
    post({ type: 'mp-close' }); endLink(); view = null;
    $.vsEndedText.textContent = text; show('ended'); refreshChrome();
  }
  $.vsHost.onclick = () => startHost();
  $.vsJoin.onclick = () => startJoin();
  $.vsConnect.onclick = async () => {
    try { $.vsConnect.disabled = true; await link.accept($.vsReply.value); } catch (e) { $.vsHostStatus.textContent = e.message; $.vsHostStatus.classList.add('bad'); $.vsConnect.disabled = false; }
  };
  $.vsJoinGo.onclick = async () => {
    try {
      $.vsJoinGo.disabled = true; $.vsJoinStatus.classList.remove('bad');
      const reply = await link.join($.vsHostIn.value);
      $.vsReplyOut.value = reply; $.vsReplyBox.hidden = false;
    } catch (e) { $.vsJoinStatus.textContent = e.message; $.vsJoinStatus.classList.add('bad'); $.vsJoinGo.disabled = false; }
  };
  const cancelPairing = () => { post({ type: 'mp-close' }); endLink(); view = null; $.vsJoinGo.disabled = false; show('home'); renderRecords(); refreshChrome(); };
  $.vsHostCancel.onclick = cancelPairing; $.vsJoinCancel.onclick = cancelPairing;

  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch {
      const ta = text === $.vsHostCode.value ? $.vsHostCode : $.vsReplyOut; ta.focus(); ta.select();
      try { document.execCommand('copy'); button.textContent = 'Copied'; } catch { button.textContent = 'Select and copy'; }
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  }
  const share = async (text) => { try { await navigator.share({ text }); } catch { /* cancelled or unsupported */ } };
  $.vsCopyHost.onclick = () => copy($.vsHostCode.value, $.vsCopyHost);
  $.vsCopyReply.onclick = () => copy($.vsReplyOut.value, $.vsCopyReply);
  $.vsShareHost.onclick = () => share($.vsHostCode.value);
  $.vsShareReply.onclick = () => share($.vsReplyOut.value);
  if (!navigator.share) { $.vsShareHost.hidden = $.vsShareReply.hidden = true; }

  // ---- lobby controls -----------------------------------------------------------------------------
  $.vsCar.onchange = () => doAction('selectCar', Number($.vsCar.value));
  $.vsAuto.onchange = () => doAction('automatic', $.vsAuto.value === '0');
  const sendRules = () => doAction('rules', {
    course: Number($.vsCourse.value), reverse: $.vsReverse.value === '1', boost: $.vsBoost.value === '0', collisions: $.vsCollide.value === '0',
  });
  for (const id of ['vsCourse', 'vsReverse', 'vsBoost', 'vsCollide']) $[id].onchange = sendRules;
  $.vsReady.onclick = () => doAction('ready', !(view?.localReady));
  $.vsStart.onclick = () => doAction('start');
  $.vsSayForm.onsubmit = (e) => { e.preventDefault(); const text = $.vsSay.value; if (text.trim()) { doAction('say', text); $.vsSay.value = ''; } };
  const leave = () => { doAction('leave'); };
  $.vsLeave.onclick = leave; $.vsLostLeave.onclick = leave;
  $.vsChipLeave.onclick = () => { if (!view || confirm('Leave the race? It will not be recorded.')) leave(); };
  $.vsEndedOk.onclick = () => { view = null; endLink(); show('home'); renderRecords(); refreshChrome(); };
  $.vsClose.onclick = () => setOpen(false);
  button.onclick = () => { if (open) { setOpen(false); return; } if (!sessionLive() && screen === 'ended') show('home'); setOpen(true); };

  function renderRecords(summary) {
    if (!summary) { post({ type: 'mp-records' }); return; }
    const rows = summary.cars.map((c) => el('div', { textContent: `${CAR_NAMES[c.car] ?? `Car ${c.car}`}: ${c.record.battles} battles · ${c.record.wins} wins · Lv ${c.record.level}` }));
    const hist = summary.history.slice(-8).reverse().map((h) => el('div', { textContent: `${h.result} · ${COURSES[h.course] ?? '?'} · vs ${h.opponent}` }));
    $.vsRecords.replaceChildren(...(rows.length ? [...rows, ...hist] : [el('div', { textContent: 'No online races yet. Records are kept on this device, per car.' })]));
  }

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map((o) => el('option', { value: String(o.value), textContent: o.text })));
    select.value = String(value);
  }
  function renderLobby(v) {
    $.vsLobbyStatus.textContent = v.status;
    $.vsLobbyStatus.classList.toggle('bad', !!v.error);
    $.vsMeName.textContent = `${v.name} (you)`; $.vsThemName.textContent = v.remoteName || '…';
    const rec = (r) => (r ? `${r.battles} battles · ${r.wins} wins · Lv ${r.level}${r.streak > 1 ? ` · ${r.streak} streak` : ''}` : '');
    $.vsMeRecord.textContent = rec(v.record); $.vsThemRecord.textContent = rec(v.remote?.record);
    $.vsThemCar.textContent = v.remote ? `${v.remote.carName} · ${v.remote.automatic ? 'AT' : 'MT'}` : '';
    const carKey = JSON.stringify([v.garage.map((g) => g.selection), v.local?.selection]);
    if (carKey !== lastCarKey) { lastCarKey = carKey; fillSelect($.vsCar, v.garage.map((g) => ({ value: g.selection, text: g.label })), v.local.selection); }
    else $.vsCar.value = String(v.local.selection);
    $.vsAuto.value = v.local.automatic ? '0' : '1';
    const isHost = v.role === 'host';
    $.vsRulesHost.hidden = !isHost; $.vsRulesGuest.hidden = isHost;
    const r = v.rules;
    const rulesKey = JSON.stringify([isHost, r]);
    if (rulesKey !== lastRulesKey) {
      lastRulesKey = rulesKey;
      fillSelect($.vsCourse, COURSES.map((c, i) => ({ value: i, text: `${c}${i === 4 || i === 8 ? ' (night)' : ''}` })), r.course);
      fillSelect($.vsReverse, [{ value: 0, text: directionLabel(r.course, false) }, { value: 1, text: directionLabel(r.course, true) }], r.reverse ? 1 : 0);
      $.vsBoost.value = r.boost ? '0' : '1'; $.vsCollide.value = r.collisions ? '0' : '1';
      $.vsRulesGuest.textContent = `${COURSES[r.course]} · ${v.direction}${r.night ? ' · night' : ''}${r.wet ? ' · wet' : ''} · boost ${r.boost ? 'on' : 'off'} · collisions ${r.collisions ? 'on' : 'off'} (the host chooses)`;
    }
    $.vsReady.hidden = isHost; $.vsStart.hidden = !isHost;
    $.vsReady.textContent = v.localReady ? 'Not ready' : 'I am ready';
    $.vsReady.className = v.localReady ? 'alt' : 'go';
    $.vsStart.disabled = !v.canStart;
    $.vsMeBadge.textContent = isHost ? 'host' : v.localReady ? 'ready' : 'not ready'; $.vsMeBadge.classList.toggle('on', isHost || v.localReady);
    const guestReady = isHost ? v.guestReady : null;
    $.vsThemBadge.textContent = isHost ? (guestReady ? 'ready' : 'not ready') : 'host'; $.vsThemBadge.classList.toggle('on', isHost ? guestReady : true);
    // chat (append only what is new)
    if (v.chat.length !== lastChat) {
      const stick = $.vsChat.scrollTop + $.vsChat.clientHeight >= $.vsChat.scrollHeight - 8;
      $.vsChat.replaceChildren(...v.chat.map((c) => el('div', { className: c.local ? 'me' : 'them' }, el('b', { textContent: `${c.name}: ` }), document.createTextNode(c.text))));
      if (stick) $.vsChat.scrollTop = $.vsChat.scrollHeight;
      lastChat = v.chat.length;
    }
    $.vsSay.disabled = !v.canChat; $.vsSend.disabled = !v.canChat;
    $.vsHistory.replaceChildren(...(v.history.length ? v.history : [{ empty: true }]).map((h) => (h.empty
      ? el('div', { textContent: 'No online races yet.' })
      : el('div', { textContent: `${h.result} · ${COURSES[h.course] ?? '?'} · vs ${h.opponent} · ${h.ticks ? fmtTime(h.ticks) : '—'}` }))));
  }

  // ---- messages from the worker ---------------------------------------------------------------------
  function onWorkerMessage(m) {
    if (m.type === 'mp-send') {
      link?.send(m.data, m.reliable);
    } else if (m.type === 'mp-view') {
      const before = view?.state;
      view = m.view;
      window.__versus = view;
      const racing = ['loading', 'countdown', 'racing', 'results'].includes(view.state);
      // Entering the lobby (first time, or back from a race) brings the panel up; a player who closed it keeps it closed.
      if (view.state === 'lobby') { if (screen !== 'lobby' || before !== 'lobby') { show('lobby'); setOpen(true); } renderLobby(view); }
      else if (view.state === 'disconnected') { $.vsLostText.textContent = view.status; show('lost'); setOpen(true); }
      else if (racing) { if (open) setOpen(false); }
      refreshChrome();
    } else if (m.type === 'mp-records') {
      renderRecords(m);
    } else if (m.type === 'mp-ended') {
      const wasConnected = !!view;
      endLink(); view = null; window.__versus = null; lastChat = -1; lastCarKey = lastRulesKey = '';
      $.vsEndedText.textContent = m.reason || 'The session ended.';
      show('ended'); if (wasConnected || screen === 'ended') setOpen(true);
      refreshChrome();
    }
  }

  show('home');
  refreshChrome();
  getBuildId().then((id) => { buildId = id; });
  return {
    onWorkerMessage,
    /** The game is up: the button may show. */
    setReady() { ready = true; refreshChrome(); },
    setDriving(value) { driving = !!value; refreshChrome(); },
    /** Keys typed into the panel must not reach the game. */
    capturesKeys: (event) => !!event.target?.closest?.('#versus, #vsChip'),
    get resultsActive() { return view?.state === 'results'; },
    get open() { return open; },
  };
}
