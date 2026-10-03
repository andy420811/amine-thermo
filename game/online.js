/* Capture City 2050 — online race.
   Friends in one room play the same town (same seed, region and level) month by month: nobody runs
   ahead of the slowest player, the host sets the speed, and a panel shows every city's numbers live.
   Rooms live in a Firebase Realtime Database (FIREBASE_CONFIG below; rules in tools/firebase_rules.json).
   ?net=local swaps in a same-browser channel so two tabs can race without Firebase (for testing).
   Only the nickname and game numbers are sent; nothing else about the player. */
(function () {
  'use strict';
  const CC = window.CC;
  if (!CC) return;

  // the web-app config from the Firebase console (Project settings → Your apps → Config); null = online off
  // (these keys are meant to be public; what anyone may read or write is set by the database rules)
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyB24gSSORrWLAmSSB-gpySS9RnLQi1jqFI',
    authDomain: 'amine-thermo-c9cc0.firebaseapp.com',
    databaseURL: 'https://amine-thermo-c9cc0-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'amine-thermo-c9cc0',
    appId: '1:828095109987:web:e8029f22fc2e9e45155156',
  };
  const FB_VER = '10.12.2';
  const LOCAL = /[?&]net=local/.test(location.search);
  const ENABLED = LOCAL || !!FIREBASE_CONFIG;
  const MAX_PLAYERS = 8, BEAT = 4000, STALE = 15000;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const { L, M } = CC;
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pid = Math.random().toString(36).slice(2, 10);   // one per page load, so two tabs are two players

  // ---------- transports: a room is one small tree { meta: {...}, players: { pid: {...} } } ----------
  function localTransport() {
    const key = c => 'cc2050-net-' + c;
    const read = c => { try { return JSON.parse(localStorage.getItem(key(c)) || 'null'); } catch (e) { return null; } };
    const subs = {};
    window.addEventListener('storage', e => { for (const c in subs) if (e.key === key(c)) subs[c](read(c)); });
    const t = {
      async get(c) { return read(c); },
      async put(c, path, val) {   // path: '' (whole room), 'meta' or 'players/<pid>'; null removes
        let r = read(c) || {};
        const [a, b] = path ? path.split('/') : [];
        if (!a) r = val;
        else if (b) { r[a] = r[a] || {}; if (val == null) delete r[a][b]; else r[a][b] = val; }
        else if (val == null) delete r[a]; else r[a] = val;
        if (r && Object.keys(r).length) localStorage.setItem(key(c), JSON.stringify(r)); else localStorage.removeItem(key(c));
        if (subs[c]) subs[c](read(c));
      },
      watch(c, cb) { subs[c] = cb; cb(read(c)); return () => { delete subs[c]; }; },
      onLeave(c, path) { window.addEventListener('pagehide', () => { t.put(c, path, null); }); },
    };
    return t;
  }
  async function firebaseTransport() {
    const base = `https://www.gstatic.com/firebasejs/${FB_VER}/`;
    const [app, D] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-database.js')]);
    const db = D.getDatabase(app.initializeApp(FIREBASE_CONFIG));
    const R = (c, p) => D.ref(db, `rooms/${c}${p ? '/' + p : ''}`);
    return {
      async get(c) { return (await D.get(R(c))).val(); },
      put(c, path, val) { return D.set(R(c, path), val); },
      watch(c, cb) { return D.onValue(R(c), s => cb(s.val())); },
      onLeave(c, path) { D.onDisconnect(R(c, path)).remove(); },
    };
  }
  let T = null;
  async function transport() { if (!T) T = LOCAL ? localTransport() : await firebaseTransport(); return T; }

  // ---------- room state ----------
  let noteUntil = 0;
  let code = null, room = null, unwatch = null, beat = null, started = false, ended = false, speedNow = null, waitingFor = null, err = '';
  const seen = {};   // pid -> { ts, at }: when WE last saw that player's record change (device clocks may disagree)
  const isHost = () => !!(room && room.meta && room.meta.host === pid);
  const players = () => Object.entries((room && room.players) || {});
  const alive = ([id, p]) => id === pid || (seen[id] && Date.now() - seen[id].at < STALE && p);
  const myName = () => CC.nick() || L('Player ', '玩家 ') + pid.slice(0, 3).toUpperCase();
  const ym = m => { m = Math.min(m, 299); return L(`${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m % 12]} ${M.START_YEAR + Math.floor(m / 12)}`, `${M.START_YEAR + Math.floor(m / 12)} 年 ${m % 12 + 1} 月`); };

  function record() {
    const r = { name: myName(), ts: Date.now(), m: 0, away: document.hidden };
    if (!started) return r;
    const S = CC.S;
    return Object.assign(r, {
      m: S.m, rate: +(S.rate || 0).toFixed(2), lim: +M.limit(S).toFixed(2), breach: Math.round(S.greenhouse), anger: Math.round(S.anger),
      funds: Math.round(S.funds), cap: +S.captured.toFixed(1), score: M.score(S), stars: M.stars(S),
      over: S.over ? (S.over.win ? 'win' : S.over.why) : '',
    });
  }
  const publish = () => { if (code && T) T.put(code, 'players/' + pid, record()); };

  async function create() {
    err = '';
    try {
      await transport();
      let c = null;
      for (let i = 0; i < 6 && !c; i++) {
        const t = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
        if (!(await T.get(t))) c = t;
      }
      if (!c) throw new Error(L('Could not make a room, try again.', '開房失敗，請再試一次。'));
      await T.put(c, 'meta', { host: pid, seed: Math.floor(Math.random() * 1e9), region: CC.region, diff: CC.diff === 'hell' ? 'normal' : CC.diff, speed: 1, state: 'lobby', created: Date.now(), v: 1 });
      enter(c);
    } catch (e) { err = e.message || String(e); render(); }
  }
  async function join(c) {
    err = '';
    c = (c || '').trim().toUpperCase();
    try {
      if (!/^[A-Z2-9]{4}$/.test(c)) throw new Error(L('The room code has 4 letters or digits.', '房間代碼是 4 個英文字母或數字。'));
      await transport();
      const r = await T.get(c);
      if (!r || !r.meta) throw new Error(L('No room with that code.', '找不到這個房間。'));
      if (r.meta.state !== 'lobby') throw new Error(L('That race has already started.', '這場已經開始了。'));
      if (Object.keys(r.players || {}).length >= MAX_PLAYERS) throw new Error(L(`The room is full (${MAX_PLAYERS}).`, `房間滿了(${MAX_PLAYERS} 人)。`));
      enter(c);
    } catch (e) { err = e.message || String(e); render(); }
  }
  function enter(c) {
    code = c; started = false; ended = false; speedNow = null;
    T.onLeave(c, 'players/' + pid);
    publish();
    unwatch = T.watch(c, onRoom);
    beat = setInterval(publish, BEAT);
    render();
  }
  function leave() {
    if (!code) return;
    const c = code, closing = isHost() && room && room.meta && room.meta.state === 'lobby';
    if (unwatch) unwatch();
    clearInterval(beat);
    if (T) T.put(c, closing ? '' : 'players/' + pid, null);
    code = null; room = null; started = false; ended = false; waitingFor = null;
    CC.NET.canStep = null;
    renderPanel(); render();
  }

  function onRoom(r) {
    room = r;
    if (!r || !r.meta) {
      if (code) { const was = started; code = null; started = false; CC.NET.canStep = null; clearInterval(beat); if (unwatch) unwatch(); err = was ? '' : L('The host closed the room.', '房主關閉了房間。'); renderPanel(); render(); }
      return;
    }
    const now = Date.now();
    for (const [id, p] of players()) if (!seen[id] || seen[id].ts !== p.ts) seen[id] = { ts: p.ts, at: now };
    // the host left: the first live player (by id) takes over
    const live = players().filter(alive).map(([id]) => id).sort();
    if (!live.includes(r.meta.host) && live[0] === pid) T.put(code, 'meta', Object.assign({}, r.meta, { host: pid }));
    if (r.meta.state === 'playing' && !started) begin(r.meta);
    if (started && r.meta.speed !== speedNow) { speedNow = r.meta.speed; CC.setSpeed(speedNow); }
    renderPanel(); render(); renderRank();
  }
  function begin(meta) {
    started = true;
    $('ovNet').hidden = true;
    CC.start(meta.seed, meta.region, meta.diff);
    speedNow = meta.speed || 1; CC.setSpeed(speedNow);
    CC.NET.canStep = canStep;
    publish();
  }
  function startRace() {
    if (!isHost()) return;
    T.put(code, 'meta', Object.assign({}, room.meta, { state: 'playing', started: Date.now() }));
  }
  function setMeta(k, v) { if (isHost() && room.meta.state === 'lobby') T.put(code, 'meta', Object.assign({}, room.meta, { [k]: v })); }

  // the race: step from month m only when every live, unfinished friend has reached m too
  function canStep(m) {
    if (!code || !started) return true;
    for (const e of players()) {
      const [id, p] = e;
      if (id === pid || !alive(e) || p.over || p.away) continue;   // a hidden tab does not hold the room up; it catches up when it is back
      if ((p.m || 0) < m) { if (waitingFor !== p.name) { waitingFor = p.name; renderPanel(); } return false; }
    }
    if (waitingFor) { waitingFor = null; renderPanel(); }
    return true;
  }
  document.addEventListener('visibilitychange', publish);
  CC.NET.onMonth = () => { if (code && started) publish(); };
  CC.NET.onEnd = () => { if (code && started) { ended = true; publish(); setTimeout(renderRank, 50); } };

  // ---------- UI ----------
  const css = document.createElement('style');
  css.textContent = `
.netpanel { position: absolute; top: 6px; left: 6px; z-index: 5; background: rgba(11, 20, 34, .88); border: 1px solid var(--line); border-radius: 10px; padding: 6px 8px; color: var(--fg); font: 12px var(--mono); max-width: min(56%, 420px); }
.netpanel .nh { display: flex; gap: 8px; align-items: center; justify-content: space-between; color: var(--muted); font-size: 11.5px; margin-bottom: 3px; }
.netpanel .nh b { color: var(--amine); }
.netpanel .nh .wait { color: var(--gold); }
.netpanel .nh button { background: none; border: 0; color: var(--muted); cursor: pointer; font: inherit; padding: 0 2px; }
.netpanel table { border-collapse: collapse; width: 100%; }
.netpanel th { font-weight: 400; color: var(--muted); text-align: right; padding: 1px 4px; font-size: 11px; }
.netpanel td { text-align: right; padding: 1px 4px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.netpanel td:first-child, .netpanel th:first-child { text-align: left; max-width: 96px; overflow: hidden; text-overflow: ellipsis; }
.netpanel tr.me td { color: #FFF; font-weight: 700; }
.netpanel .bad { color: var(--anger); } .netpanel .ok { color: var(--good); } .netpanel .lag { color: var(--gold); }

.netpanel.min table { display: none; }
@media (max-width: 700px) { .netpanel .nopt { display: none; } .netpanel { max-width: 62%; } }
@media (max-height: 560px) { .netpanel .nopt { display: none; } .netpanel { font-size: 11px; padding: 4px 6px; max-width: 30%; } .netpanel td, .netpanel th { padding: 0 3px; } .netpanel td:first-child { max-width: 64px; } }
.netcode { font: 700 clamp(34px, 9vw, 52px) var(--mono); letter-spacing: 8px; color: var(--amine); margin: 4px 0 2px; }
.netlist { display: grid; gap: 6px; margin: 10px 0; }
.netlist div { background: var(--panel-2); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; justify-content: space-between; gap: 8px; }
.netrow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 10px 0; }
.netrow input, .netrow select { background: var(--panel-2); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; font: 600 15px var(--mono); }
.netrow input { width: 7em; text-transform: uppercase; letter-spacing: 3px; }
.neterr { color: var(--anger); min-height: 1.2em; margin: 4px 0; }
.netrank { margin: 10px 0; }
.netrank h4 { margin: 0 0 6px; }
`;
  document.head.appendChild(css);

  const ov = document.createElement('div');
  ov.className = 'overlay'; ov.id = 'ovNet'; ov.hidden = true;
  ov.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="netTitle"><button class="xclose" id="netX" aria-label="Close">×</button><div id="netBody"></div></div>';
  document.body.appendChild(ov);
  $('netX').onclick = () => { ov.hidden = true; };
  ov.addEventListener('click', e => { if (e.target === ov) ov.hidden = true; });

  const panel = document.createElement('div');
  panel.className = 'netpanel'; panel.id = 'netPanel'; panel.hidden = true;
  $('sceneBox').appendChild(panel);
  let panelMin = false;

  const netBtn = document.createElement('button');
  netBtn.className = 'btn ghost'; netBtn.id = 'netBtn';
  $('startBtn').parentNode.insertBefore(netBtn, $('startBtn').nextSibling);
  netBtn.onclick = () => { ov.hidden = false; render(); };

  const regionName = id => { const r = M.REGIONS[id]; return r ? (CC.lang === 'zh' && r.zh && r.zh.label ? r.zh.label : r.label) : id; };
  const diffName = id => { const d = M.DIFFS[id]; return d ? L(d.label, d.zh) : id; };

  function render() {
    netBtn.textContent = L('🌐 Play online', '🌐 連線對戰');
    if (ov.hidden) return;
    const body = $('netBody');
    if (!ENABLED) {
      body.innerHTML = `<h3 id="netTitle">${L('Play online', '連線對戰')}</h3><p class="lead">${L('Online play is not set up on this copy yet (no database configured).', '這個版本還沒設定連線(缺資料庫設定)。')}</p>`;
      return;
    }
    if (!code) {
      body.innerHTML = `<h3 id="netTitle">${L('Play online', '連線對戰')}</h3>
        <p class="lead">${L('Race friends on the same town: everyone moves month by month together, and you see each other\'s numbers live. Up to 8 players.', '跟朋友在同一座城市比賽:大家逐月一起前進,即時看到彼此的數字。最多 8 人。')}</p>
        <p>${L('Your name', '你的名字')}: <b>${esc(myName())}</b> <small style="color:var(--muted)">${L('(set the nickname on the region page)', '(在選地區頁改暱稱)')}</small></p>
        <div class="netrow"><button class="btn" id="netCreate">${L('Create a room', '建立房間')}</button></div>
        <div class="netrow"><input id="netCode" maxlength="4" placeholder="ABCD" aria-label="${L('Room code', '房間代碼')}" autocomplete="off"><button class="btn ghost" id="netJoin">${L('Join', '加入')}</button></div>
        <div class="neterr">${esc(err)}</div>`;
      $('netCreate').onclick = create;
      $('netJoin').onclick = () => join($('netCode').value);
      $('netCode').onkeydown = e => { if (e.key === 'Enter') join($('netCode').value); };
      return;
    }
    if (!room || !room.meta) { body.innerHTML = `<p class="lead">${L('Connecting…', '連線中…')}</p>`; return; }
    const meta = room.meta, host = isHost();
    const list = players().filter(alive).map(([id, p]) => `<div><span>${esc(p.name)}${id === pid ? L(' (you)', '(你)') : ''}</span><span style="color:var(--muted)">${id === meta.host ? L('host', '房主') : ''}</span></div>`).join('');
    const regs = Object.keys(M.REGIONS).map(id => `<option value="${id}" ${id === meta.region ? 'selected' : ''}>${esc(regionName(id))}</option>`).join('');
    const difs = Object.entries(M.DIFFS).filter(([, d]) => !d.hidden).map(([id]) => `<option value="${id}" ${id === meta.diff ? 'selected' : ''}>${esc(diffName(id))}</option>`).join('');
    body.innerHTML = `<h3 id="netTitle">${L('Room', '房間')}</h3>
      <div class="netcode">${code}</div>
      <p class="lead">${L('Send this code to your friends; they tap "Play online" and enter it.', '把代碼傳給朋友,他們按「連線對戰」輸入代碼就能加入。')}</p>
      ${host ? `<div class="netrow"><select id="netRg" aria-label="Region">${regs}</select><select id="netDf" aria-label="Level">${difs}</select></div>`
        : `<p>${L('Region', '地區')}: <b>${esc(regionName(meta.region))}</b> · ${L('Level', '難度')}: <b>${esc(diffName(meta.diff))}</b></p>`}
      <div class="netlist">${list}</div>
      <div class="btn-row">${host ? `<button class="btn" id="netGo">${L('Start the race', '開始比賽')}</button>` : `<span style="color:var(--muted)">${L('Waiting for the host to start…', '等待房主開始…')}</span>`}
        <button class="btn ghost" id="netLeave">${L('Leave', '離開')}</button></div>
      <div class="neterr">${esc(err)}</div>`;
    if (host) {
      $('netRg').onchange = e => setMeta('region', e.target.value);
      $('netDf').onchange = e => setMeta('diff', e.target.value);
      $('netGo').onclick = startRace;
    }
    $('netLeave').onclick = leave;
  }

  function cells(p, mine) {
    const ratio = p.lim > 0 ? p.rate / p.lim : 0;
    const res = p.over ? (p.over === 'win' ? `<span class="ok">✓ ${'★'.repeat(p.stars || 0)}</span>` : `<span class="bad">✗ ${ym(Math.max(0, (p.m || 1) - 1))}</span>`) : '';
    return `<td>${esc(p.name)}</td>
      <td class="${ratio > 1 ? 'bad' : ''}">${res || Math.round(ratio * 100) + '%'}</td>
      <td class="${p.anger >= 70 ? 'bad' : ''}">${p.anger == null ? '—' : p.anger + '%'}</td>
      <td class="nopt ${p.funds < 0 ? 'bad' : ''}">${p.funds == null ? '—' : CC.money(p.funds)}</td>
      <td class="nopt">${p.cap == null ? '—' : CC.fmt(p.cap, 1)}</td>
      <td>${p.score == null ? '—' : CC.fmt(p.score)}</td>
      <td class="lag">${!p.over && !mine && started && CC.S && p.m < CC.S.m ? '⏳' : ''}</td>`;
  }
  function renderPanel() {
    panel.hidden = !(code && started);
    if (panel.hidden) return;
    const rows = players().filter(alive).sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
    panel.classList.toggle('min', panelMin);
    panel.innerHTML = `<div class="nh"><span><b>${code}</b> · ${ym(CC.S.m)}${waitingFor ? ` · <span class="wait">${L('waiting for ', '等待 ')}${esc(waitingFor)}…</span>` : ''}${Date.now() < noteUntil ? ` · <span class="wait">${L('the host sets the speed', '速度由房主控制')}</span>` : ''}</span><button id="netMin" aria-label="${panelMin ? L('Show', '展開') : L('Hide', '收起')}">${panelMin ? '▾' : '▴'}</button></div>
      <table><tr><th>${L('Player', '玩家')}</th><th>CO₂/${L('limit', '限額')}</th><th>${L('Anger', '民怨')}</th><th class="nopt">${L('Funds', '資金')}</th><th class="nopt">${L('Stored Mt', '封存 Mt')}</th><th>${L('Score', '分數')}</th><th></th></tr>
      ${rows.map(([id, p]) => `<tr class="${id === pid ? 'me' : ''}">${cells(id === pid ? record() : p, id === pid)}</tr>`).join('')}</table>`;
    $('netMin').onclick = () => { panelMin = !panelMin; renderPanel(); };
  }
  setInterval(() => { if (code && started && !ended) renderPanel(); }, 1000);   // my own row and the lag marks between months

  // the end screen: the room's ranking (still-playing friends are listed at the bottom)
  function renderRank() {
    let box = $('netRank');
    if (!code || !ended) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.className = 'netrank'; box.id = 'netRank'; $('endGrid').parentNode.insertBefore(box, $('endGrid').nextSibling); }
    const rows = players().map(([id, p]) => [id, id === pid ? record() : p]).sort((a, b) => (!!b[1].over - !!a[1].over) || (b[1].over === 'win') - (a[1].over === 'win') || (b[1].score || 0) - (a[1].score || 0));
    box.innerHTML = `<h4>${L('Room ', '房間 ')}${code} · ${L('ranking', '排名')}</h4><div class="netlist">${rows.map(([id, p], i) => `<div><span>${p.over ? i + 1 + '. ' : ''}${esc(p.name)}${id === pid ? L(' (you)', '(你)') : ''}</span><span>${p.over ? (p.over === 'win' ? '✓ ' + '★'.repeat(p.stars || 0) + ' · ' : '✗ · ') + CC.fmt(p.score || 0) : L('still playing · ', '還在玩 · ') + ym(p.m || 0)}</span></div>`).join('')}</div>`;
  }

  // only the host changes the speed during a race; leaving the end screen or starting a solo game leaves the room
  const SPEEDS = { sp0: 0, sp1: 1, sp2: 2, sp4: 4, pausedBadge: 1 };
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#sp0, #sp1, #sp2, #sp4, #pausedBadge');
    if (b && code && started && !ended) {
      if (isHost()) T.put(code, 'meta', Object.assign({}, room.meta, { speed: SPEEDS[b.id] }));
      else { e.stopImmediatePropagation(); e.preventDefault(); noteUntil = Date.now() + 3000; renderPanel(); }
      return;
    }
    if (e.target.closest && e.target.closest('#againBtn, #startBtn') && code) leave();
  }, true);

  // re-label when the language changes
  new MutationObserver(() => { render(); renderPanel(); renderRank(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  render();
})();
