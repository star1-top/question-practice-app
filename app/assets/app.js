/* ================= 主应用 ================= */
(function (Q) {
  'use strict';
  const P = Q.parse, AI = Q.ai, C = Q.cloud;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const uid = () => 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const todayKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const fmtDate = ts => { if (!ts) return ''; const d = new Date(ts); return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

  const LS = { banks: 'qpb_banks_v2', progress: 'qpb_progress_v2', notes: 'qpb_notes_v2', catalogBanks: 'qpb_catalog_banks_v1', selected: 'qpb_selected_bank_v1', theme: 'qpb_theme', dirty: 'qpb_progress_pending_v1' };
  const TABS = ['market', 'practice', 'exam', 'recite', 'wrong', 'notes', 'stats', 'banks', 'account'];

  const S = {
    banks: [], bankId: null, courseKey: null, tab: 'market',
    catalog: [], catalogErr: '', unlocks: {}, opening: {},
    marketQ: '', marketOnly: 'all',
    db: null, notes: [], cloudBanksLoaded: false,
    filter: { main: '', sec: '', type: '', order: 'seq', scope: 'all', kw: '' },
    pq: [], pi: 0, pSelected: [], pAnswered: false, pStat: { right: 0, done: 0 },
    sid: null, pFinished: false, bankTagAtStart: null, qAt: 0,
    exam: null, reciteShow: true, reciteLimit: 60,
    booted: false, saveTimer: null, pendingLoginReason: ''
  };
  const defaultDb = () => ({ rec: {}, wrong: [], star: [], daily: {} });

  /* ================= 工具 ================= */
  function toast(msg, kind) {
    const box = $('#toastBox');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }
  function costOf(action) {
    const p = C.pricing || Q_CONFIG.defaults;
    return p.cost && p.cost[action] != null ? p.cost[action] : (Q_CONFIG.defaults.cost[action] ?? 1);
  }
  function credits() { return C.profile ? C.profile.credits : 0; }
  function balCents() { return C.profile ? (C.profile.balance_cents || 0) : 0; }
  function yuan(cents) { return (cents / 100).toFixed(2).replace(/\.00$/, ''); }

  /* ================= 本地存储 ================= */
  function readLS(key, dft) {
    try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? dft : v; } catch (e) { return dft; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { toast('本机存储空间不足，建议登录后存到云端', 'bad'); return false; }
  }

  /* ================= 题库 ================= */
  function curBank() { return S.banks.find(b => b.id === S.bankId) || null; }
  function curCourse() {
    const b = curBank(); if (!b) return null;
    return (b.courses || []).find(c => c.key === S.courseKey) || (b.courses || [])[0] || null;
  }
  function curFlat() {
    const b = curBank(), c = curCourse();
    if (!b || !c) return [];
    return P.flatten({ courses: [c] });
  }
  function curChapters() {
    const b = curBank(), c = curCourse();
    if (!b || !c) return [];
    return P.chapterMeta({ courses: [c] }, c.key);
  }
  function bankQCount(b) { return b.question_count || P.countQuestions(b); }

  function loadLocalBanks() {
    const list = readLS(LS.banks, []);
    return Array.isArray(list) ? list : [];
  }
  function saveLocalBanks() {
    const locals = S.banks.filter(b => b.local && !b.builtin);
    writeLS(LS.banks, locals);
  }
  function saveCatalogBanks(removedId) {
    const saved = readLS(LS.catalogBanks, []);
    const ids = (Array.isArray(saved) ? saved : []).concat(S.banks.filter(b => b.catalogId).map(b => b.catalogId));
    writeLS(LS.catalogBanks, [...new Set(ids.filter(id => id !== removedId))]);
  }
  async function syncCatalogBookmark(bank) {
    if (!C.session || bank.cloudId || !S.cloudBanksLoaded) return;
    try {
      const row = await C.createBank({ title: bank.title, subject: bank.subject,
        source_kind: 'catalog_bookmark', source_name: '题库广场',
        data: { catalogId: bank.catalogId }, question_count: bankQCount(bank) });
      if (!row || !row.id) throw new Error('未取得云端题库编号');
      bank.cloudId = row.id;
      const cached = localProgressMap()[bank.id];
      if (cached && !(await C.getProgress(row.id))) { markDirty(bank, cached); await retryProgress(); }
    } catch (e) { console.warn('云端保存题库失败', e); toast('题库已保存在本机，云端同步暂时失败', 'bad'); }
  }
  async function restoreCatalogBanks() {
    const saved = readLS(LS.catalogBanks, []);
    const ids = [...new Set((Array.isArray(saved) ? saved : []).concat(S.banks.filter(b => b.catalogId).map(b => b.catalogId)))];
    for (const id of ids) {
      let bank = S.banks.find(b => b.catalogId === id);
      const item = catalogItem(id);
      if (!item || !isUnlocked(item)) continue;
      try {
        if (!bank || !bank.courses.length) {
          const row = await C.fetchCatalogBank(id);
          if (!row || !row.chapters) continue;
          const made = P.makeBank({ title: item.title + (item.org ? ' · ' + item.org : ''), subject: item.org || '', chapters: row.chapters, source_kind: 'catalog', source_name: '内置题库' });
          if (bank) { bank.courses = made.courses; bank.meta = made.meta; }
          else {
            bank = { id: 'k' + id, catalogId: id, local: false, builtin: true,
              title: made.title, subject: made.subject, courses: made.courses, meta: made.meta,
              question_count: item.question_count || P.countQuestions(made), kind: item.kind, org: item.org };
            S.banks.push(bank);
          }
        }
        await syncCatalogBookmark(bank);
      } catch (e) { console.warn('恢复题库失败', id, e); }
    }
    const selected = readLS(LS.selected, null);
    if (selected && S.banks.some(b => b.id === selected)) S.bankId = selected;
    else if (!S.bankId && S.banks.length) S.bankId = S.banks[0].id;
  }

  async function loadCloudBanks() {
    if (!C.session) return [];
    try {
      const rows = await C.listBanks();
      S.cloudBanksLoaded = true;
      return rows.map(r => ({
        id: r.data && r.data.catalogId ? 'k' + r.data.catalogId : 'c' + r.id,
        cloudId: r.id, catalogId: r.data && r.data.catalogId || null,
        builtin: !!(r.data && r.data.catalogId), local: false,
        title: r.title, subject: r.subject || '',
        courses: (r.data && r.data.courses) || [],
        meta: (r.data && r.data.meta) || {},
        source_kind: r.source_kind, source_name: r.source_name,
        question_count: r.question_count || 0,
        created_at: r.created_at
      }));
    } catch (e) {
      S.cloudBanksLoaded = false;
      console.warn(e);
      toast('云端题库暂时加载失败，请检查网络后重试', 'bad');
      return S.banks.filter(b => b.cloudId);
    }
  }

  async function mergeBanks() {
    const locals = loadLocalBanks();
    const clouds = await loadCloudBanks();
    const existing = S.banks.filter(b => b.catalogId);
    S.banks = locals.concat(clouds.filter((b, i) => !clouds.slice(0, i).some(other => other.id === b.id)));
    existing.forEach(b => {
      const found = S.banks.find(x => x.id === b.id);
      if (found) { if (!found.courses.length) { found.courses = b.courses; found.meta = b.meta; } }
      else S.banks.push(b);
    });
    if (!S.bankId || !S.banks.some(b => b.id === S.bankId)) {
      S.bankId = S.banks.length ? S.banks[0].id : null;
      S.courseKey = null;
    }
  }

  /* ================= 题库市场 ================= */
  async function loadCatalog() {
    try {
      S.catalog = await C.listCatalog();
      S.catalogErr = '';
      if (C.session) {
        try {
          const rows = await C.myUnlocks();
          const m = {};
          rows.forEach(r => { m[r.catalog_id] = true; });
          S.unlocks = m;
        } catch (e) { console.warn('unlocks', e); }
      } else {
        S.unlocks = {};
      }
    } catch (e) {
      S.catalogErr = e.message || '题库目录加载失败';
      console.warn('catalog', e);
    }
  }

  function catalogItem(id) { return S.catalog.find(x => x.id === id) || null; }
  function isUnlocked(item) { return !item || item.kind === 'free' || !!S.unlocks[item.id]; }

  /** 把市场里的科目变成可练习的题库（内容按需拉取，不预加载 98 科） */
  async function openCatalogBank(id, opts) {
    opts = Object.assign({ tab: 'practice', autostart: true }, opts || {});
    const item = catalogItem(id);
    if (!item) { toast('题库不存在', 'bad'); return; }
    const exist = S.banks.find(b => b.catalogId === id);
    track('bank_open', { bank: id, p: { kind: item.kind || 'free', locked: isUnlocked(item) ? 0 : 1 } });
    if (exist) { await enterBank(exist.id, opts); return; }

    if (!isUnlocked(item)) {
      track('unlock_click', { bank: id, p: { price: item.price_cents || 100 } });
      if (!C.session) {
        track('unlock_blocked', { bank: id, p: { reason: 'auth' } });
        openAuth('login', '这套题库需要登录后解锁，注册送 1 次 AI 整理知识点');
        return;
      }
      const price = item.price_cents || 100;
      if (balCents() < price) {
        track('unlock_blocked', { bank: id, p: { reason: 'balance', balance: balCents(), price: price } });
        openRecharge(item, price);
        return;
      }
      const ok = await confirmUnlock(item);
      if (!ok) return;
    }

    if (S.opening[id]) return;
    S.opening[id] = true;
    toast('正在载入「' + item.title + '」…');
    try {
      const row = await C.fetchCatalogBank(id);
      if (!row || !row.chapters) throw new Error('内容拉取失败，请稍后重试');
      const made = P.makeBank({
        title: item.title + (item.org ? ' · ' + item.org : ''),
        subject: item.org || '',
        chapters: row.chapters,
        source_kind: 'catalog',
        source_name: '内置题库'
      });
      const bank = {
        id: 'k' + id, catalogId: id, local: false, builtin: true,
        title: made.title, subject: made.subject,
        courses: made.courses, meta: made.meta,
        question_count: item.question_count || 0,
        kind: item.kind, org: item.org
      };
      S.banks.push(bank);
      saveCatalogBanks();
      await syncCatalogBookmark(bank);
      await enterBank(bank.id, opts);
      return bank;
    } catch (e) {
      toast('载入失败：' + (e.message || '重试'), 'bad');
    } finally {
      S.opening[id] = false;
    }
  }

  async function enterBank(bankId, opts) {
    await selectBank(bankId);
    S.tab = (opts && opts.tab) || 'practice';
    render();
    // 从题库页点「开始练」直接进答题，不用再点一次「开始练习」
    if (S.tab === 'practice' && opts && opts.autostart && !S.pq.length) startPractice();
    window.scrollTo({ top: 0 });
  }

  function confirmUnlock(item) {
    const price = item.price_cents || 100;
    return new Promise(resolve => {
      openModal('<div class="modal-head"><h3>解锁这套题库</h3><button class="x" data-close>×</button></div>'
        + '<div class="modal-body">'
        + '<div class="unlock-box"><div class="unlock-title">' + esc(item.title) + (item.org ? '<span class="tiny muted"> · ' + esc(item.org) + '</span>' : '') + '</div>'
        + '<div class="unlock-meta">' + item.question_count + ' 题 · ' + item.chapter_count + ' 章</div></div>'
        + '<div class="unlock-row"><span>本套题库价格</span><b>¥' + (price / 100).toFixed(2) + '</b></div>'
        + '<div class="unlock-row"><span>当前余额</span><b>¥' + (balCents() / 100).toFixed(2) + '</b></div>'
        + '<p class="tiny muted">解锁后永久可练，换设备也能用。余额不足请用余额码充值；兑换码请联系我获取。</p>'
        + '</div><div class="modal-foot"><button class="btn" data-close>再想想</button>'
        + '<button class="btn primary" id="doUnlock">确认解锁 ¥' + (price / 100).toFixed(2) + '</button></div>');
      document.querySelector('[data-close]').onclick = () => { track('unlock_cancel', { bank: item.id }); closeModal(); resolve(false); };
      document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => { track('unlock_cancel', { bank: item.id }); closeModal(); resolve(false); });
      const btn = document.getElementById('doUnlock');
      btn.onclick = async () => {
        btn.disabled = true; btn.textContent = '解锁中…';
        try {
          const r = await C.unlock(item.id);
          if (!r || !r.ok) {
            closeModal();
            if (r && r.reason === 'insufficient') { openRecharge(item, price); }
            else if (r && r.reason === 'auth') { openAuth('login', '请先登录'); }
            else toast('解锁失败', 'bad');
            resolve(false);
            return;
          }
          S.unlocks[item.id] = true;
          track('unlock_success', { bank: item.id, p: { price: price, balance: balCents() } });
          closeModal();
          toast('已解锁「' + item.title + '」', 'ok');
          refreshBankSelect();
          resolve(true);
        } catch (e) {
          btn.disabled = false; btn.textContent = '重试';
          toast('解锁失败：' + (e.message || ''), 'bad');
          resolve(false);
        }
      };
    });
  }

  async function selectBank(id) {
    // 换题库前先把上一个练习会话收尾，否则「答到一半就走」统计不到
    if (S.bankId !== id) closeSession();
    if (S.bankId !== id) await flushProgressSave();
    S.bankId = id;
    writeLS(LS.selected, id);
    const b = curBank();
    S.courseKey = b && b.courses && b.courses[0] ? b.courses[0].key : null;
    S.filter = { main: '', sec: '', type: '', order: 'seq', scope: 'all', kw: '' };
    S.pq = []; S.pi = 0; S.pAnswered = false; S.pSelected = [];
    await loadProgressFor(b);
    await loadNotesFor(b);
    refreshBankSelect();
    render();
  }

  function localProgressMap() { return readLS(LS.progress, {}); }
  function localNotesMap() { return readLS(LS.notes, {}); }

  function accountId() { return C.user && C.user.id || C.session && C.session.user && C.session.user.id || null; }
  function dirtyKey(bank) { const id = accountId(); return id && bank && bank.cloudId ? id + ':' + bank.cloudId : null; }
  function dirtyMap() { return readLS(LS.dirty, {}); }
  function syncStatus(message, failed) {
    let el = $('#syncStatus');
    if (!el) return;
    el.textContent = message;
    el.title = failed ? '记录保存在本机，恢复网络后自动重试' : '';
  }
  function markDirty(bank, db) {
    const key = dirtyKey(bank); if (!key) return;
    const pending = dirtyMap();
    pending[key] = JSON.parse(JSON.stringify(db));
    writeLS(LS.dirty, pending);
    syncStatus(navigator.onLine ? '记录待同步' : '离线 · 记录待同步');
  }
  // 同一账号、同一题库串行写入，失败保留持久队列。切换账号不能上传别人的记录。
  let syncing = false;
  async function retryProgress() {
    if (syncing || !C.session || !navigator.onLine) return;
    syncing = true;
    try {
      const prefix = accountId() + ':';
      for (const [key, snapshot] of Object.entries(dirtyMap())) {
        if (!key.startsWith(prefix)) continue;
        try {
          await C.saveProgress(key.slice(prefix.length), snapshot);
          const pending = dirtyMap();
          if (JSON.stringify(pending[key]) === JSON.stringify(snapshot)) {
            delete pending[key]; writeLS(LS.dirty, pending);
          }
        } catch (e) { console.warn('进度同步失败', e); syncStatus('同步失败 · 点击重试', true); return; }
      }
      syncStatus('记录已同步');
    } finally { syncing = false; }
  }
  async function loadProgressFor(bank) {
    S.db = defaultDb();
    if (!bank) return;
    const cached = localProgressMap()[bank.id];
    const pending = dirtyKey(bank) && dirtyMap()[dirtyKey(bank)];
    if (cached) S.db = Object.assign(defaultDb(), cached);
    if (bank.cloudId && C.session && navigator.onLine) {
      try {
        const remote = await C.getProgress(bank.cloudId);
        // 未同步的本机记录优先，防止重新登录或切设备时覆盖离线答题。
        if (remote && !pending) S.db = Object.assign(defaultDb(), remote);
        if (pending) S.db = Object.assign(defaultDb(), pending);
        const map = localProgressMap(); map[bank.id] = S.db; writeLS(LS.progress, map);
        if (pending) retryProgress(); else syncStatus('记录已同步');
      } catch (e) { console.warn(e); syncStatus('云端读取失败 · 点击重试', true); }
    } else if (pending) syncStatus('离线 · 记录待同步');
    else if (bank.cloudId && !navigator.onLine) syncStatus('离线 · 记录保存在本机');
  }
  async function flushProgressSave() {
    if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; }
    await retryProgress();
  }
  function saveProgressSoon() {
    if (!S.bankId) return;
    const map = localProgressMap();
    map[S.bankId] = S.db;
    writeLS(LS.progress, map);
    const b = curBank();
    if (b && b.cloudId && C.session) {
      markDirty(b, S.db);
      if (S.saveTimer) clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(flushProgressSave, 1200);
    } else syncStatus(C.session ? '仅保存在本机' : '未登录 · 仅保存在本机');
  }

  async function loadNotesFor(bank) {
    S.notes = [];
    if (!bank) return;
    if (bank.cloudId && C.session) {
      try { S.notes = await C.listNotes(bank.cloudId); } catch (e) { console.warn(e); }
    }
    if (!S.notes.length) {
      const local = localNotesMap()[bank.id];
      if (local && local.length) S.notes = local;
    }
  }
  function saveLocalNotes() {
    const map = localNotesMap();
    map[S.bankId] = S.notes;
    writeLS(LS.notes, map);
  }

  /* ================= 顶栏 ================= */
  function refreshBankSelect() {
    const sel = $('#bankSelect');
    if (!S.banks.length) {
      sel.innerHTML = '<option value="">暂无题库</option>';
    } else {
      sel.innerHTML = S.banks.map(b => {
        const tag = b.builtin ? '示例' : b.cloudId ? '云端' : '本机';
        return '<option value="' + esc(b.id) + '"' + (b.id === S.bankId ? ' selected' : '') + '>' + esc(b.title) + '（' + tag + ' · ' + bankQCount(b) + ' 题）</option>';
      }).join('');
    }
    const u = $('#userBtn');
    if (C.session) {
      const email = C.currentEmail() || '已登录';
      u.textContent = email.split('@')[0];
      u.title = email;
      u.classList.add('on');
    } else {
      u.textContent = '登录';
      u.title = '登录后可云端保存题库、使用 AI';
      u.classList.remove('on');
    }
    const cp = $('#creditBtn');
    const cn = $('#creditNum');
    if (C.session) {
      cn.textContent = credits();
      cp.classList.toggle('low', credits() <= 0);
      cp.title = 'AI 可用次数，可在「我的」兑换码充值';
    } else {
      cn.textContent = '--';
      cp.classList.remove('low');
      cp.title = '登录后查看 AI 次数';
    }
    const b = curBank();
    $('#footStat').textContent = b ? ('当前题库 ' + bankQCount(b) + ' 道题') : '共 0 道题';
  }

  /* ================= 渲染入口 ================= */
  function render() {
    refreshBankSelect();
    $$('#navTabs button').forEach(b => {
      b.classList.toggle('on', b.dataset.tab === S.tab);
      if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    const pageLabel = $('#navTabs button[data-tab="' + S.tab + '"]');
    if ($('#currentPage') && pageLabel) $('#currentPage').textContent = pageLabel.textContent;
    document.body.dataset.view = S.tab;
    TABS.forEach(t => {
      const el = $('#view-' + t);
      if (el) el.classList.toggle('hide', t !== S.tab);
    });
    // 地址栏同步标签，方便收藏 / 分享「错题本」这类直达链接
    try {
      if (location.hash.slice(1) !== S.tab) history.replaceState(null, '', '#' + S.tab);
    } catch (e) {}
    if (S.tab === 'market') renderMarket();
    if (S.tab === 'practice') renderPractice();
    if (S.tab === 'exam') renderExam();
    if (S.tab === 'recite') renderRecite();
    if (S.tab === 'wrong') renderWrong();
    if (S.tab === 'notes') renderNotes();
    if (S.tab === 'stats') renderStats();
    if (S.tab === 'banks') renderBanks();
    if (S.tab === 'account') renderAccount();
  }

  function emptyBanksHtml() {
    return '<div class="card"><div class="empty">'
      + '<div class="ico"></div><h3>还没有选中题库</h3>'
      + '<p>去「题库广场」挑一套内置题库，或者把你手上的 PDF / Word / Markdown / 一段文字导进来。</p>'
      + '<div class="row" style="justify-content:center">'
      + '<button class="btn primary" data-act="go-market">去题库广场</button>'
      + '<button class="btn" data-act="open-import">导入我的题库</button>'
      + '</div></div></div>';
  }

  /* ================= 练习 ================= */
  function renderPractice() {
    const view = $('#view-practice');
    const bank = curBank();
    if (!bank) { view.innerHTML = emptyBanksHtml(); bindActs(view); return; }
    const flat = curFlat();
    if (!flat.length) {
      view.innerHTML = '<div class="card"><div class="empty"><div class="ico"></div><h3>这个题库是空的</h3><p>换一个题库，或重新导入。</p>'
        + '<button class="btn primary" data-act="open-import">导入题库</button></div></div>';
      bindActs(view); return;
    }
    const courses = bank.courses || [];
    const courseChips = courses.length > 1
      ? '<div class="chips" style="margin-bottom:12px">' + courses.map(c =>
        '<button class="chip ' + (c.key === S.courseKey ? 'on' : '') + '" data-course="' + esc(c.key) + '">' + esc(c.short || c.course) + '</button>').join('') + '</div>'
      : '';
    view.innerHTML = '<div class="page-heading"><h1>' + esc(bank.title) + '</h1><p>按章节练习，把每一题学得更明白。</p></div><details class="card practice-filters"' + ((!S.pq.length || window.matchMedia('(min-width:761px)').matches) ? ' open' : '') + '><summary>练习设置<span>章节 · 题型 · 顺序</span></summary><div class="filter-content">' + courseChips
      + '<div class="filter-bar">'
      + '<select id="fChapter"></select><select id="fSection"></select><select id="fType">'
      + '<option value="">全部题型</option><option>单选题</option><option>多选题</option><option>判断题</option></select>'
      + '<select id="fOrder"><option value="seq">顺序</option><option value="rand">随机</option></select>'
      + '<select id="fScope"><option value="all">全部题</option><option value="undone">未做过的</option><option value="wrong">做错的</option><option value="star">收藏的</option></select>'
      + '</div>'
      + '<div class="row" style="margin-top:10px">'
      + '<input class="grow" id="fSearch" type="search" placeholder="搜索题干关键词（回车筛选）">'
      + '<button class="btn primary" id="startBtn">开始练习</button>'
      + '<button class="btn" id="resetFilter">重置</button></div>'
      + '<div class="small muted" id="filterInfo" style="margin-top:8px"></div></div></details>'
      + '<p class="small muted" id="syncStatus" role="status" tabindex="0">' + (C.session ? '检查同步状态…' : '未登录 · 仅保存在本机') + '</p>'
      + '<div id="practiceBody" class="hide"></div>';
    fillChapterSelect();
    fillSectionSelect();
    updateFilterInfo();
    $('#fChapter').onchange = () => { S.filter.main = $('#fChapter').value; fillSectionSelect(); updateFilterInfo(); };
    $('#fSection').onchange = () => { S.filter.sec = $('#fSection').value; updateFilterInfo(); };
    $('#fType').onchange = () => { S.filter.type = $('#fType').value; updateFilterInfo(); };
    $('#fScope').onchange = () => { S.filter.scope = $('#fScope').value; updateFilterInfo(); };
    $('#fOrder').onchange = () => { S.filter.order = $('#fOrder').value; };
    $('#fSearch').oninput = () => { S.filter.kw = $('#fSearch').value.trim(); updateFilterInfo(); };
    $('#fSearch').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); updateFilterInfo(); } };
    $('#resetFilter').onclick = () => {
      S.filter = { main: '', sec: '', type: '', order: 'seq', scope: 'all', kw: '' };
      S.reciteLimit = 60;
      renderPractice();
    };
    $('#syncStatus').onclick = retryProgress;
    $('#startBtn').onclick = startPractice;
    $$('[data-course]', view).forEach(el => {
      el.onclick = () => { S.courseKey = el.dataset.course; S.filter = { main: '', sec: '', type: '', order: 'seq', scope: 'all', kw: '' }; renderPractice(); };
    });
    if (S.pq.length) renderPracticeQuestion();
    bindActs(view);
  }

  function fillChapterSelect() {
    const meta = curChapters();
    const mains = [];
    meta.forEach(m => { if (mains.indexOf(m.main) < 0) mains.push(m.main); });
    const sel = $('#fChapter');
    if (!sel) return;
    sel.innerHTML = '<option value="">全部章节</option>' + mains.map(m => {
      const arr = meta.filter(x => x.main === m);
      const n = arr.reduce((a, b) => a + b.count, 0);
      return '<option value="' + esc(m) + '">第' + esc(m) + '章 ' + esc(arr[0].name) + '（' + n + '题）</option>';
    }).join('');
    sel.value = S.filter.main;
  }
  function fillSectionSelect() {
    const meta = curChapters();
    const sel = $('#fSection');
    if (!sel) return;
    const secs = S.filter.main ? meta.filter(m => m.main === S.filter.main) : meta;
    sel.innerHTML = '<option value="">全部小节</option>' + secs.map(m =>
      '<option value="' + esc(m.sec) + '">' + esc(m.title) + '（' + m.count + '题）</option>').join('');
    sel.value = S.filter.sec;
  }
  function currentList() {
    let list = curFlat();
    const f = S.filter;
    if (f.main) list = list.filter(q => q.main === f.main);
    if (f.sec) list = list.filter(q => q.sec === f.sec);
    if (f.type) list = list.filter(q => q.type === f.type);
    if (f.kw) {
      const k = f.kw.toLowerCase();
      list = list.filter(q => (q.stem + ' ' + q.options.map(o => o.v).join(' ')).toLowerCase().indexOf(k) >= 0);
    }
    if (f.scope === 'undone') list = list.filter(q => !(S.db.rec[q.id] && S.db.rec[q.id].done));
    if (f.scope === 'wrong') list = list.filter(q => S.db.wrong.indexOf(q.id) >= 0);
    if (f.scope === 'star') list = list.filter(q => S.db.star.indexOf(q.id) >= 0);
    return list;
  }
  function updateFilterInfo() {
    const info = $('#filterInfo');
    if (!info) return;
    const list = currentList();
    info.textContent = '当前筛选：' + list.length + ' 题' + (list.length ? '，点「开始练习」进入答题。' : '，请调整筛选条件。');
  }
  function startPractice() {
    const list = currentList();
    if (!list.length) { toast('当前筛选没有题目，换个条件试试'); return; }
    closeSession();
    S.pq = S.filter.order === 'rand' ? shuffle(list) : list;
    const resume = S.filter.order === 'seq' && S.filter.scope === 'all' && !S.filter.main && !S.filter.sec && !S.filter.type && !S.filter.kw
      ? S.pq.findIndex(q => q.id === S.db.cursor && !S.db.rec[q.id]?.done) : -1;
    S.pi = resume >= 0 ? resume : 0; S.pStat = { right: 0, done: 0 };
    S.sid = newSessionId();
    S.bankTagAtStart = bankTag();
    S.pFinished = false;
    track('practice_start', { bank: S.bankTagAtStart, sid: S.sid,
      p: { count: S.pq.length, order: S.filter.order, scope: S.filter.scope, type: S.filter.type || 'all' } });
    const filters = $('.practice-filters');
    if (filters && window.matchMedia('(max-width:760px)').matches) filters.open = false;
    renderPracticeQuestion();
  }
  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function recOf(id) { return S.db.rec[id] || { done: 0, right: 0, wrong: 0 }; }
  function markDone(q, ok) {
    const r = recOf(q.id);
    r.done++; ok ? r.right++ : r.wrong++;
    S.db.rec[q.id] = r;
    const w = S.db.wrong;
    if (!ok && w.indexOf(q.id) < 0) w.push(q.id);
    if (ok && w.indexOf(q.id) >= 0) w.splice(w.indexOf(q.id), 1);
    S.db.daily[todayKey()] = (S.db.daily[todayKey()] || 0) + 1;
    S.db.cursor = S.pq[S.pi + 1] ? S.pq[S.pi + 1].id : null;
    saveProgressSoon();
  }
  function isStar(id) { return S.db.star.indexOf(id) >= 0; }
  function toggleStar(id) {
    const s = S.db.star; const i = s.indexOf(id);
    i < 0 ? s.push(id) : s.splice(i, 1);
    saveProgressSoon();
  }
  function ansDetail(q) {
    if (q.type === '判断题') return q.answer === '√' ? '正确' : '错误';
    return q.options.filter(o => q.answer.indexOf(o.k) >= 0).map(o => o.v).join('　');
  }
  function ansText(q) {
    if (q.type === '判断题') return q.answer === '√' ? '正确' : '错误';
    return q.options.filter(o => q.answer.indexOf(o.k) >= 0).map(o => o.k + '. ' + o.v).join('　');
  }

  function renderPracticeQuestion() {
    const body = $('#practiceBody');
    if (!body) return;
    body.classList.remove('hide');
    if (S.pi >= S.pq.length) { renderPracticeEnd(body); return; }
    const q = S.pq[S.pi];
    const r = recOf(q.id);
    S.pAnswered = false; S.pSelected = [];
    S.qAt = Date.now();
    let optsHtml = '';
    if (q.type === '判断题') {
      optsHtml = ['√', 'X'].map(v => '<button class="opt" data-opt="' + v + '"><span class="k">' + (v === '√' ? '✔' : '✘') + '</span><span>' + (v === '√' ? '正确' : '错误') + '</span></button>').join('');
    } else {
      optsHtml = q.options.map(o => '<button class="opt" data-opt="' + esc(o.k) + '"><span class="k">' + esc(o.k) + '</span><span>' + esc(o.v) + '</span></button>').join('');
    }
    body.innerHTML = '<div class="card">'
      + '<div class="card-head"><div class="row">'
      + '<span class="q-no">第 ' + (S.pi + 1) + ' / ' + S.pq.length + ' 题</span>'
      + '<span class="tag gray">' + esc(q.type) + '</span><span class="tag">' + esc(q.secName) + ' ' + esc(q.sec) + '</span>'
      + (r.done ? '<span class="small muted">已答 ' + r.done + ' 次 · 对 ' + r.right + '</span>' : '')
      + '</div><div class="row">'
      + '<button class="star ' + (isStar(q.id) ? 'on' : '') + '" id="starBtn" title="收藏（S）">★</button>'
      + '<span class="kbd-hint">正确率 ' + pct(S.pStat.right, S.pStat.done) + '</span></div></div>'
      + '<div class="progress"><i style="width:' + (S.pi / S.pq.length * 100) + '%"></i></div>'
      + '<div class="q-stem">' + esc(q.stem) + '</div>'
      + (q.note ? '<div class="note"> ' + esc(q.note) + '</div>' : '')
      + '<div class="opts" id="optBox">' + optsHtml + '</div>'
      + '<div id="fb"></div>'
      + '<div class="row" style="margin-top:14px">'
      + '<button class="btn" id="prevBtn"' + (S.pi === 0 ? ' disabled' : '') + '>上一题</button>'
      + '<button class="btn primary" id="nextBtn">下一题</button>'
      + (q.type === '多选题' ? '<button class="btn" id="submitBtn" disabled>提交答案</button>' : '')
      + '<button class="btn" id="showBtn">看答案</button><button class="btn ghost" id="reportBtn">题目报错</button>'
      + '<span class="kbd-hint grow" style="text-align:right">A/B/C/D 选择 · 多选按 Enter 提交 · S 收藏</span></div></div>';

    $$('#optBox .opt').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.opt;
        if (S.pAnswered) return;
        if (q.type === '多选题') {
          const i = S.pSelected.indexOf(k);
          i < 0 ? S.pSelected.push(k) : S.pSelected.splice(i, 1);
          btn.classList.toggle('sel', S.pSelected.indexOf(k) >= 0);
          $('#submitBtn').disabled = S.pSelected.length === 0;
        } else {
          answerPractice([k]);
        }
      };
    });
    $('#starBtn').onclick = () => { toggleStar(q.id); $('#starBtn').classList.toggle('on', isStar(q.id)); };
    $('#prevBtn').onclick = () => { if (S.pi > 0) { S.pi--; renderPracticeQuestion(); } };
    $('#nextBtn').onclick = () => { if (S.pAnswered) nextPractice(); else { toast('先答一下，或点「看答案」'); } };
    $('#showBtn').onclick = () => revealAnswer();
    $('#reportBtn').onclick = () => reportQuestion(q);
    if ($('#submitBtn')) $('#submitBtn').onclick = () => { if (!S.pAnswered) answerPractice(S.pSelected); };
  }

  async function reportQuestion(q) {
    if (!C.session) { openAuth('login', '登录后可以反馈题目错误'); return; }
    const reason = prompt('请写明问题：答案错误、题干/选项错误、重复题、缺少解析等（至少 5 个字）');
    if (reason === null) return;
    if (reason.trim().length < 5 || reason.length > 500) { toast('请填写 5–500 字的问题说明', 'bad'); return; }
    const bank = curBank();
    try {
      await C.reportQuestion({ catalog_id: bank.catalogId || null, bank_id: bank.cloudId || null,
        question_id: q.id, stem: q.stem, answer: q.answer, reason: reason.trim() });
      toast('已提交，核对后会修正', 'ok');
    } catch (e) { toast('提交失败：' + (e.message || '请稍后重试'), 'bad'); }
  }

  function reviewOptions(q, sel, answer) {
    $$('#optBox .opt').forEach(btn => {
      const k = btn.dataset.opt;
      btn.classList.add('locked');
      btn.classList.remove('sel');
      if (answer.indexOf(k) >= 0) btn.classList.add('right');
      else if (sel.indexOf(k) >= 0) btn.classList.add('wrong');
      if (sel.indexOf(k) >= 0 && answer.indexOf(k) >= 0) btn.classList.add('sel');
    });
  }

  function answerPractice(sel) {
    const q = S.pq[S.pi];
    if (!sel.length || S.pAnswered) return;
    S.pAnswered = true;
    S.pSelected = sel.slice();
    const answer = (q.answer || '').split('').sort().join('');
    const mine = sel.slice().sort().join('');
    const ok = !!q.answer && answer === mine;
    const repeat = recOf(q.id).done > 0;
    S.pStat.done++; if (ok) S.pStat.right++;
    track('answer', { sid: S.sid, ok: ok, ms: Date.now() - (S.qAt || Date.now()),
      p: { t: q.type, i: S.pi + 1, rep: repeat ? 1 : 0 } });
    markDone(q, ok);
    reviewOptions(q, sel, q.answer || '');
    const fb = $('#fb');
    if (!q.answer) {
      fb.innerHTML = '<div class="fb bad">这道题没有答案，无法判分。可以在题库里补答案，或让 AI 补全。</div>';
    } else {
      fb.innerHTML = '<div class="fb ' + (ok ? 'ok' : 'bad') + '"><b>' + (ok ? '答对了' : '答错了') + '</b>　正确答案：' + esc(q.answer) + (ansDetail(q) ? '　' + esc(ansDetail(q)) : '') + '</div>';
    }
    const h = $('.card-head .kbd-hint');
    if (h) h.textContent = '正确率 ' + pct(S.pStat.right, S.pStat.done);
  }

  function revealAnswer() {
    const q = S.pq[S.pi];
    if (S.pAnswered) return;
    S.pAnswered = true;
    reviewOptions(q, [], q.answer || '');
    $('#fb').innerHTML = '<div class="fb bad"><b>答案：' + esc(q.answer || '未录入') + '</b>' + (q.type !== '判断题' && q.answer ? '　' + esc(ansText(q)) : '') + '</div>';
    track('reveal', { sid: S.sid, ok: false, ms: Date.now() - (S.qAt || Date.now()),
      p: { t: q.type, i: S.pi + 1 } });
    markDone(q, false);
  }

  function nextPractice() {
    if (S.pi < S.pq.length - 1) { S.pi++; S.db.cursor = S.pq[S.pi].id; saveProgressSoon(); renderPracticeQuestion(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else { S.pi = S.pq.length; S.db.cursor = null; saveProgressSoon(); renderPracticeQuestion(); }
  }

  function renderPracticeEnd(body) {
    const total = S.pq.length;
    const acc = pct(S.pStat.right, S.pStat.done);
    // 同一轮可能被重复渲染（切标签页回来），完成事件只报一次
    if (!S.pFinished) {
      S.pFinished = true;
      track('practice_finish', { bank: S.bankTagAtStart, sid: S.sid, ok: true,
        p: { total: total, answered: S.pStat.done, right: S.pStat.right } });
    }
    body.innerHTML = '<div class="card"><div class="empty">'
      + '<div class="ico">' + (acc >= 80 ? '' : acc >= 60 ? '' : '') + '</div>'
      + '<h3>这一轮做完了</h3>'
      + '<p>共 ' + total + ' 题，答对 ' + S.pStat.right + ' 道，正确率 ' + acc + '%。' + (acc < 60 ? '错题已经收进错题本，过一遍再练。' : '') + '</p>'
      + '<div class="stat-grid" style="max-width:520px;margin:0 auto 16px">'
      + '<div class="stat"><b>' + total + '</b><span>本轮题量</span></div>'
      + '<div class="stat"><b>' + S.pStat.right + '</b><span>答对</span></div>'
      + '<div class="stat"><b>' + acc + '%</b><span>正确率</span></div>'
      + '</div>'
      + '<div class="row" style="justify-content:center">'
      + '<button class="btn primary" id="againBtn">再来一轮</button>'
      + '<button class="btn" id="wrongBtn">只看错题</button>'
      + '<button class="btn ghost" id="backFilter">改筛选条件</button></div></div></div>';
    $('#againBtn').onclick = () => startPractice();
    $('#wrongBtn').onclick = () => { S.filter.scope = 'wrong'; if (!currentList().length) { toast('还没有错题'); return; } startPractice(); };
    $('#backFilter').onclick = () => { S.pq = []; renderPractice(); };
  }

  /* ================= 模拟考试 ================= */
  function renderExam() {
    const view = $('#view-exam');
    const bank = curBank();
    if (!bank) { view.innerHTML = emptyBanksHtml(); bindActs(view); return; }
    if (!S.exam) {
      view.innerHTML = '<div class="card"><div class="card-head"><h2>模拟考试</h2><span class="small muted">交卷后统一判分，不即时提示对错</span></div>'
        + '<div class="grid three">'
        + '<label class="field"><span>题量</span><select id="eCount"><option value="10">10 题</option><option value="20" selected>20 题</option><option value="50">50 题</option><option value="100">100 题</option><option value="0">全部</option></select></label>'
        + '<label class="field"><span>时长</span><select id="eTime"><option value="10">10 分钟</option><option value="20" selected>20 分钟</option><option value="30">30 分钟</option><option value="60">60 分钟</option><option value="0">不限时</option></select></label>'
        + '<label class="field"><span>范围</span><select id="eChapter"></select></label>'
        + '</div>'
        + '<button class="btn primary lg" id="examStart" style="margin-top:6px">开始考试</button>'
        + '<p class="small muted" style="margin-bottom:0">考试中按顺序作答，可随时跳题。时间到自动交卷。</p></div>';
      const meta = curChapters();
      const mains = [];
      meta.forEach(m => { if (mains.indexOf(m.main) < 0) mains.push(m.main); });
      $('#eChapter').innerHTML = '<option value="">全部章节</option>' + mains.map(m =>
        '<option value="' + esc(m) + '">第' + esc(m) + '章 ' + esc(meta.find(x => x.main === m).name) + '</option>').join('');
      $('#examStart').onclick = startExam;
      bindActs(view);
      return;
    }
    const ex = S.exam;
    if (ex.submitted) { renderExamResult(view); return; }
    const q = ex.qs[ex.idx];
    const sel = ex.ans[ex.idx] || [];
    const left = ex.left;
    const timeText = left < 0 ? '不限时' : (String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0'));
    view.innerHTML = '<div class="card"><div class="card-head"><div class="row"><span class="q-no">第 ' + (ex.idx + 1) + ' / ' + ex.qs.length + ' 题</span>'
      + '<span class="tag gray">' + esc(q.type) + '</span><span class="tag warn">⏱ ' + timeText + '</span></div>'
      + '<button class="btn sm danger" id="examSubmitTop">交卷</button></div>'
      + '<div class="progress"><i style="width:' + (ex.ans.filter(a => a && a.length).length / ex.qs.length * 100) + '%"></i></div>'
      + '<div class="q-stem">' + esc(q.stem) + '</div>'
      + '<div class="opts">' + (q.type === '判断题'
        ? ['√', 'X'].map(v => '<button class="opt ' + (sel.indexOf(v) >= 0 ? 'sel' : '') + '" data-eopt="' + v + '"><span class="k">' + (v === '√' ? '✔' : '✘') + '</span><span>' + (v === '√' ? '正确' : '错误') + '</span></button>').join('')
        : q.options.map(o => '<button class="opt ' + (sel.indexOf(o.k) >= 0 ? 'sel' : '') + '" data-eopt="' + esc(o.k) + '"><span class="k">' + esc(o.k) + '</span><span>' + esc(o.v) + '</span></button>').join('')) + '</div>'
      + '<div class="row" style="margin-top:14px"><button class="btn" id="ePrev"' + (ex.idx === 0 ? ' disabled' : '') + '>上一题</button>'
      + '<button class="btn primary" id="eNext">下一题</button>'
      + '<span class="small muted grow" style="text-align:right">已答 ' + ex.ans.filter(a => a && a.length).length + ' / ' + ex.qs.length + '</span></div>'
      + '</div>'
      + '<div class="card"><div class="small muted" style="margin-bottom:8px">答题卡（点数字跳题）</div><div id="eSheet" class="row tight"></div></div>';
    $$('[data-eopt]').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.eopt;
        if (q.type === '多选题') {
          const arr = ex.ans[ex.idx] || [];
          const i = arr.indexOf(k);
          i < 0 ? arr.push(k) : arr.splice(i, 1);
          ex.ans[ex.idx] = arr;
        } else {
          ex.ans[ex.idx] = [k];
        }
        renderExam();
      };
    });
    $('#ePrev').onclick = () => { if (ex.idx > 0) { ex.idx--; renderExam(); } };
    $('#eNext').onclick = () => { if (ex.idx < ex.qs.length - 1) { ex.idx++; renderExam(); } else submitExam(true); };
    $('#examSubmitTop').onclick = () => submitExam(false);
    const sheet = $('#eSheet');
    ex.qs.forEach((qq, i) => {
      const answered = ex.ans[i] && ex.ans[i].length;
      const b = document.createElement('button');
      b.className = 'chip' + (i === ex.idx ? ' on' : '');
      b.textContent = String(i + 1);
      if (answered) b.style.borderColor = 'var(--brand)';
      b.onclick = () => { ex.idx = i; renderExam(); };
      sheet.appendChild(b);
    });
  }

  function startExam() {
    let list = curFlat();
    const ch = $('#eChapter').value;
    if (ch) list = list.filter(q => q.main === ch);
    const n = parseInt($('#eCount').value, 10);
    const mins = parseInt($('#eTime').value, 10);
    if (!list.length) { toast('这个范围没有题目'); return; }
    const qs = shuffle(list).slice(0, n || list.length);
    S.exam = { qs, idx: 0, ans: qs.map(() => []), left: mins ? mins * 60 : -1, submitted: false, timer: null };
    if (mins) {
      S.exam.timer = setInterval(() => {
        if (!S.exam || S.exam.submitted) return;
        S.exam.left--;
        if (S.exam.left <= 0) { clearInterval(S.exam.timer); submitExam(true); return; }
        const t = $('.tag.warn');
        if (t) t.textContent = '⏱ ' + String(Math.floor(S.exam.left / 60)).padStart(2, '0') + ':' + String(S.exam.left % 60).padStart(2, '0');
      }, 1000);
    }
    renderExam();
  }

  function submitExam(auto) {
    const ex = S.exam;
    if (!ex || ex.submitted) return;
    const unanswered = ex.ans.filter(a => !a || !a.length).length;
    if (!auto && unanswered > 0 && !confirm('还有 ' + unanswered + ' 题没答，确定交卷？')) return;
    if (ex.timer) clearInterval(ex.timer);
    ex.submitted = true;
    let right = 0;
    ex.qs.forEach((q, i) => {
      const a = (q.answer || '').split('').sort().join('');
      const m = (ex.ans[i] || []).slice().sort().join('');
      const ok = !!q.answer && a === m;
      if (ok) right++;
      markDone(q, ok);
    });
    ex.result = { right, total: ex.qs.length, score: Math.round(right / ex.qs.length * 100) };
    renderExam();
  }

  function renderExamResult(view) {
    const ex = S.exam;
    const r = ex.result;
    view.innerHTML = '<div class="card"><div class="empty" style="padding-bottom:20px"><div class="ico">' + (r.score >= 80 ? '' : r.score >= 60 ? '' : '') + '</div>'
      + '<h3>得分 ' + r.score + ' 分</h3><p>答对 ' + r.right + ' / ' + r.total + ' 题。错题已自动收进错题本。</p>'
      + '<div class="row" style="justify-content:center"><button class="btn primary" id="examAgain">再考一次</button><button class="btn" id="examReview">查看错题</button></div></div></div>'
      + '<div class="card"><div class="card-title" style="margin-bottom:10px">逐题回顾</div>'
      + ex.qs.map((q, i) => {
        const a = (q.answer || '').split('').sort().join('');
        const m = (ex.ans[i] || []).slice().sort().join('');
        const ok = !!q.answer && a === m;
        return '<div class="qitem"><div class="t">' + (i + 1) + '. ' + esc(q.stem) + '</div>'
          + '<div class="small ' + (ok ? 'muted' : '') + '" style="color:' + (ok ? 'var(--ok)' : 'var(--bad)') + '">'
          + (ok ? '✓ 正确' : '✗ 你的答案：' + esc((ex.ans[i] || []).join('') || '未答') + '　正确答案：' + esc(q.answer || '未录入')) + '</div></div>';
      }).join('') + '</div>';
    $('#examAgain').onclick = () => { S.exam = null; renderExam(); };
    $('#examReview').onclick = () => { S.exam = null; S.tab = 'wrong'; render(); };
    bindActs(view);
  }

  /* ================= 背题 ================= */
  function renderRecite() {
    const view = $('#view-recite');
    const bank = curBank();
    if (!bank) { view.innerHTML = emptyBanksHtml(); bindActs(view); return; }
    const list = currentList();
    const shown = list.slice(0, S.reciteLimit);
    view.innerHTML = '<div class="card"><div class="card-head"><h2>背题模式</h2>'
      + '<div class="row"><span class="small muted">' + list.length + ' 题</span>'
      + '<button class="btn sm" id="toggleAns">' + (S.reciteShow ? '隐藏答案' : '显示答案') + '</button></div></div>'
      + '<div class="filter-bar"><select id="rChapter"></select><select id="rType"><option value="">全部题型</option><option>单选题</option><option>多选题</option><option>判断题</option></select></div>'
      + '<div class="small muted" style="margin-top:8px">按章节顺序通读，先在脑子里过一遍答案，再展开核对。</div></div>'
      + '<div class="card">' + (shown.length ? shown.map((q, i) => {
        return '<div class="qitem"><div class="t">' + (i + 1) + '. ' + esc(q.stem) + '</div>'
          + (q.options.length ? '<div class="small muted">' + q.options.map(o => esc(o.k) + '. ' + esc(o.v)).join('　') + '</div>' : '')
          + (S.reciteShow ? '<div class="small" style="margin-top:6px;color:var(--ok)"><b>答案：' + esc(q.answer ? (q.type === '判断题' ? (q.answer === '√' ? '正确' : '错误') : ansText(q)) : '未录入') + '</b>'
            + (q.note ? '　<span class="muted">' + esc(q.note) + '</span>' : '') + '</div>' : '')
          + '</div>';
      }).join('') : '<div class="empty"><p>当前筛选没有题目</p></div>')
      + (list.length > shown.length ? '<div style="text-align:center;margin-top:10px"><button class="btn" id="moreRecite">再显示 60 题</button></div>' : '')
      + '</div>';
    const meta = curChapters();
    const mains = [];
    meta.forEach(m => { if (mains.indexOf(m.main) < 0) mains.push(m.main); });
    $('#rChapter').innerHTML = '<option value="">全部章节</option>' + mains.map(m =>
      '<option value="' + esc(m) + '"' + (S.filter.main === m ? ' selected' : '') + '>第' + esc(m) + '章 ' + esc(meta.find(x => x.main === m).name) + '</option>').join('');
    $('#rType').value = S.filter.type;
    $('#rChapter').onchange = () => { S.filter.main = $('#rChapter').value; S.filter.sec = ''; S.reciteLimit = 60; renderRecite(); };
    $('#rType').onchange = () => { S.filter.type = $('#rType').value; S.reciteLimit = 60; renderRecite(); };
    $('#toggleAns').onclick = () => { S.reciteShow = !S.reciteShow; renderRecite(); };
    if ($('#moreRecite')) $('#moreRecite').onclick = () => { S.reciteLimit += 60; renderRecite(); };
    bindActs(view);
  }

  /* ================= 错题本 ================= */
  function renderWrong() {
    const view = $('#view-wrong');
    const bank = curBank();
    if (!bank) { view.innerHTML = emptyBanksHtml(); bindActs(view); return; }
    const all = curFlat();
    const list = S.db.wrong.map(id => all.find(q => q.id === id)).filter(Boolean);
    view.innerHTML = '<div class="card"><div class="card-head"><h2>错题本</h2><span class="tag bad">' + list.length + ' 题</span></div>'
      + (list.length ? '<div class="row"><button class="btn primary" id="practiceWrong">练这些错题</button>'
        + '<button class="btn" id="clearWrong">清空错题本</button></div>'
        + '<div style="margin-top:14px">' + list.map(q =>
          '<div class="qitem"><div class="t">' + esc(q.stem) + '</div>'
          + '<div class="small" style="color:var(--ok)">答案：' + esc(q.type === '判断题' ? (q.answer === '√' ? '正确' : '错误') : ansText(q)) + '</div>'
          + '<div class="row" style="margin-top:6px"><span class="tag gray">' + esc(q.secName) + '</span>'
          + '<span class="small muted">答错 ' + recOf(q.id).wrong + ' 次</span>'
          + '<button class="btn sm ghost" data-remove="' + esc(q.id) + '">移出错题本</button></div></div>').join('') + '</div>'
        : '<div class="empty"><div class="ico">✨</div><p>还没有错题。做错的题会自动出现在这里。</p></div>')
      + '</div>';
    if ($('#practiceWrong')) $('#practiceWrong').onclick = () => {
      S.pq = list; S.pi = 0; S.pStat = { right: 0, done: 0 }; S.tab = 'practice';
      render(); setTimeout(renderPracticeQuestion, 0);
    };
    if ($('#clearWrong')) $('#clearWrong').onclick = () => {
      if (!confirm('清空这个题库的错题记录？')) return;
      S.db.wrong = []; saveProgressSoon(); renderWrong();
    };
    $$('[data-remove]').forEach(b => b.onclick = () => {
      S.db.wrong = S.db.wrong.filter(x => x !== b.dataset.remove);
      saveProgressSoon(); renderWrong();
    });
    bindActs(view);
  }

  /* ================= 知识点 ================= */
  function renderNotes() {
    const view = $('#view-notes');
    const bank = curBank();
    if (!bank) { view.innerHTML = emptyBanksHtml(); bindActs(view); return; }
    const note = S.notes[0];
    if (!note) {
      view.innerHTML = '<div class="card"><div class="empty"><div class="ico"></div><h3>还没有知识点手册</h3>'
        + '<p>让 AI 按这个题库的章节和题目，整理一份能直接背的复习手册。首次注册赠送 1 次，之后每次消耗 ' + costOf('ai_notes') + ' 次。</p>'
        + '<button class="btn primary" data-act="gen-notes">AI 生成知识点（' + costOf('ai_notes') + ' 次）</button></div></div>';
      bindActs(view); return;
    }
    view.innerHTML = '<div class="card" style="padding:12px 14px"><div class="row">'
      + '<span class="small muted grow">' + esc(note.title || bank.title) + ' · ' + (note.created_at ? fmtDate(note.created_at) : '本机保存') + '</span>'
      + '<button class="btn sm" data-act="gen-notes">重新生成</button>'
      + '<button class="btn sm ghost" data-act="del-note" data-id="' + esc(String(note.id || 'local')) + '">删除</button></div></div>'
      + '<div class="notes-wrap"><div class="toc" id="toc"></div><div class="md" id="md">' + note.content_html + '</div></div>';
    buildToc();
    bindActs(view);
  }

  function buildToc() {
    const md = $('#md'), toc = $('#toc');
    if (!md || !toc) return;
    const hs = $$('h2,h3', md);
    if (!hs.length) { toc.style.display = 'none'; return; }
    hs.forEach((h, i) => {
      h.id = 'sec_' + i;
      const a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      if (h.tagName === 'H3') a.className = 'lv3';
      a.onclick = e => { e.preventDefault(); h.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      toc.appendChild(a);
    });
  }

  /* ================= 统计 ================= */
  function renderStats() {
    const view = $('#view-stats');
    const bank = curBank();
    if (!bank) { view.innerHTML = emptyBanksHtml(); bindActs(view); return; }
    const all = curFlat();
    const recs = S.db.rec || {};
    let done = 0, right = 0, wrongTimes = 0;
    Object.keys(recs).forEach(k => { const r = recs[k]; done += r.done || 0; right += r.right || 0; wrongTimes += r.wrong || 0; });
    const answered = all.filter(q => recs[q.id] && recs[q.id].done).length;
    const chapters = curChapters();
    const byChapter = {};
    all.forEach(q => {
      const key = q.main;
      byChapter[key] = byChapter[key] || { name: q.secName, sec: q.main, total: 0, done: 0, right: 0 };
      byChapter[key].total++;
      const r = recs[q.id];
      if (r && r.done) { byChapter[key].done++; byChapter[key].right += r.right || 0; }
    });
    const rows = Object.values(byChapter).sort((a, b) => String(a.sec).localeCompare(String(b.sec), 'zh', { numeric: true }));
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      days.push({ key, label: (d.getMonth() + 1) + '/' + d.getDate(), n: (S.db.daily || {})[key] || 0 });
    }
    const maxDay = Math.max(1, ...days.map(d => d.n));
    const weekTotal = days.reduce((a, d) => a + d.n, 0);
    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if ((S.db.daily || {})[key]) streak++;
      else if (i > 0) break;
    }
    view.innerHTML = '<div class="card"><div class="card-head"><h2>学习统计</h2><span class="small muted">' + esc(bank.title) + '</span></div>'
      + '<div class="stat-grid"><div class="stat"><b>' + all.length + '</b><span>本课程题量</span></div>'
      + '<div class="stat"><b>' + answered + '</b><span>已做过的题</span></div>'
      + '<div class="stat"><b>' + pct(right, done) + '%</b><span>累计正确率</span></div>'
      + '<div class="stat"><b>' + (S.db.wrong || []).length + '</b><span>当前错题</span></div>'
      + '<div class="stat"><b>' + streak + '</b><span>连续学习天数</span></div></div>'
      + '<div class="hr"></div>'
      + '<div class="card-title" style="margin-bottom:8px">最近 7 天答题量</div>'
      + (weekTotal === 0
        ? '<div class="small muted" style="padding:24px 0;text-align:center">还没有答题记录，去练几题就有了。</div>'
        : '<div style="display:flex;align-items:flex-end;gap:8px;height:110px;padding:4px 0">'
          + days.map(d => '<div style="flex:1;text-align:center"><div style="height:' + Math.max(4, d.n / maxDay * 78) + 'px;background:var(--brand);border-radius:5px 5px 2px 2px;margin-bottom:4px" title="' + d.n + ' 题"></div><div class="tiny muted">' + d.label + '</div></div>').join('')
          + '</div>')
      + '</div>'
      + '<div class="card"><div class="card-title" style="margin-bottom:12px">章节掌握度</div>'
      + (rows.length ? rows.map(r => {
        const p = r.done ? Math.round(r.right / r.done * 100) : 0;
        return '<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between"><span class="small">第' + esc(r.sec) + '章 ' + esc(r.name) + '</span>'
          + '<span class="tiny muted">' + r.done + '/' + r.total + ' 题 · 正确率 ' + p + '%</span></div>'
          + '<div class="bar" style="margin-top:4px"><i style="width:' + (r.done ? p : 0) + '%' + (r.done ? '' : ';background:var(--line)') + '"></i></div></div>';
      }).join('') : '<p class="small muted">还没有作答记录。</p>')
      + '</div>'
      + '<div class="card"><div class="row"><span class="small muted grow">本机记录和云端记录会保持一致（登录后）。</span>'
      + '<button class="btn sm danger" id="resetProgress">清空这个题库的练习记录</button></div></div>';
    $('#resetProgress').onclick = () => {
      if (!confirm('清空这个题库的答题记录、错题和收藏？题目本身不会删除。')) return;
      S.db = defaultDb(); saveProgressSoon(); renderStats(); toast('已清空');
    };
    bindActs(view);
  }

  /* ================= 题库管理 ================= */
  /* ================= 题库市场（首页） ================= */
  function normalizeMarketText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  function marketMatches(title, org) {
    const terms = String(S.marketQ || '').normalize('NFKC').trim().split(/[\s,，、;；]+/)
      .map(normalizeMarketText).filter(Boolean);
    if (!terms.length) return true;
    const searchable = normalizeMarketText(title) + normalizeMarketText(org);
    return terms.every(term => searchable.includes(term));
  }

  function marketList() {
    return S.catalog.filter(it => {
      if (S.marketOnly === 'free' && it.kind !== 'free') return false;
      if (S.marketOnly === 'paid' && it.kind !== 'paid') return false;
      if (S.marketOnly === 'mine') return false;
      return marketMatches(it.title, it.org);
    });
  }

  function marketMineList() {
    return S.banks.filter(b => (b.local || b.cloudId || b.catalogId)
      && marketMatches(b.title, b.subject || b.org));
  }

  function renderMarket() {
    const view = $('#view-market');
    if (!view) return;
    const total = S.catalog.length;
    const freeN = S.catalog.filter(x => x.kind === 'free').length;
    const paidN = total - freeN;
    const qTotal = S.catalog.reduce((a, b) => a + (b.question_count || 0), 0);
    const mine = marketMineList();

    const chips = [
      ['all', '全部'], ['free', '免费 · ' + freeN], ['paid', '付费 · ' + paidN], ['mine', '我的 · ' + mine.length]
    ].map(([k, label]) => '<button class="chip' + (S.marketOnly === k ? ' on' : '') + '" data-only="' + k + '">' + label + '</button>').join('');

    let body = '';
    if (S.marketOnly === 'mine') {
      body = mine.length ? '<div class="mk-grid">' + mine.map(b => mineCard(b)).join('') + '</div>'
        : '<div class="empty"><div class="ico"></div><h3>还没有自己的题库</h3>'
        + '<p>把你手上的 PDF、Word、Markdown 或一段文字导进来，就变成一套可以刷的题。</p>'
        + '<button class="btn primary" data-act="open-import">导入我的题库</button></div>';
    } else if (S.catalogErr) {
      body = '<div class="empty"><div class="ico"></div><h3>题库目录没加载出来</h3>'
        + '<p>' + esc(S.catalogErr) + '</p><button class="btn" data-act="reload-catalog">重试</button></div>';
    } else if (!S.catalog.length) {
      body = '<div class="empty"><div class="ico"></div><p>正在加载题库…</p></div>';
    } else {
      const list = marketList();
      body = list.length ? '<div class="mk-grid">' + list.map(it => marketCard(it)).join('') + '</div>'
        : '<div class="empty"><div class="ico"></div><h3>没找到「' + esc(S.marketQ) + '」</h3>'
        + '<p>' + contactLine('这套题库') + '</p>'
        + '<button class="btn primary" data-act="open-import">导入我的题库</button></div>';
    }

    const current = curBank();
    const visibleCount = S.marketOnly === 'mine' ? mine.length : marketList().length;
    const scopeName = { all: '全部题库', free: '免费题库', paid: '付费题库', mine: '我的题库' }[S.marketOnly];
    const resume = current ? '<div class="resume-row"><div><div class="resume-label">当前学习</div><strong>' + esc(current.title) + '</strong></div><button class="btn" id="resumePractice">继续练习 <span aria-hidden="true">→</span></button></div>' : '';
    view.innerHTML = '<div class="mk-hero">'
      + '<div class="mk-hero-main"><h1>题库广场</h1>'
      + '<p class="muted">选一门课，从第一题开始。也可以导入自己的学习资料。</p></div>'
      + '<div class="row"><button class="btn primary" data-act="open-import">＋ 导入题库</button></div>'
      + '</div>'
      + '<div class="mk-summary" aria-label="题库概览">'
      + '<div class="mk-summary-item"><b>' + total.toLocaleString('zh-CN') + '</b><span>套精选题库</span></div>'
      + '<div class="mk-summary-item"><b>' + qTotal.toLocaleString('zh-CN') + '</b><span>道练习题目</span></div>'
      + '<div class="mk-summary-item"><b>' + freeN + '</b><span>套免费练习</span></div></div>'
      + resume
      + '<div class="mk-toolbar">'
      + '<div class="search-field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="mkSearch" type="search" class="mk-search" aria-label="搜索课程名称或学校" placeholder="搜索课程名称或学校" value="' + esc(S.marketQ) + '"></div>'
      + '<div class="chips" role="group" aria-label="题库筛选">' + chips + '</div>'
      + '</div>'
      + '<div class="catalog-heading"><h2>' + scopeName + '</h2><span id="marketHeading" role="status">' + visibleCount + ' 套题库</span></div>'
      + '<div id="marketResults">' + body + '</div>'
      + '<div class="mk-foot muted tiny">' + contactLine('你要的题库') + '</div>';
    if ($('#resumePractice')) $('#resumePractice').onclick = () => enterBank(current.id, { tab: 'practice', autostart: true });
    $$('[data-only]', view).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.only === S.marketOnly)));

    const search = $('#mkSearch');
    if (search) {
      const updateResults = () => {
        S.marketQ = search.value;
        const list = $('#marketResults');
        const heading = $('#marketHeading');
        if (!list || !heading) return;
        const mineScope = S.marketOnly === 'mine';
        const items = mineScope ? marketMineList() : marketList();
        heading.textContent = items.length + ' 套题库';
        list.innerHTML = items.length
          ? '<div class="mk-grid">' + items.map(it => mineScope ? mineCard(it) : marketCard(it)).join('') + '</div>'
          : '<div class="empty"><h3>没找到「' + esc(S.marketQ) + '」</h3><p>'
            + (mineScope ? '试试其他关键词，或导入自己的题库。' : contactLine('这套题库')) + '</p></div>';
        bindActs(list);
        $$('[data-open]', list).forEach(b => b.onclick = () => openCatalogBank(b.dataset.open));
        $$('[data-open-mine]', list).forEach(b => b.onclick = () => enterBank(b.dataset.openMine, { tab: 'practice', autostart: true }));
        bindBankDelete(list);
      };
      ['input', 'compositionend', 'search', 'change'].forEach(event =>
        search.addEventListener(event, updateResults));
    }
    $$('[data-only]').forEach(b => b.onclick = () => { S.marketOnly = b.dataset.only; renderMarket(); });
    bindActs(view);
    $$('[data-open]', view).forEach(b => b.onclick = () => openCatalogBank(b.dataset.open));
    $$('[data-open-mine]', view).forEach(b => b.onclick = () => enterBank(b.dataset.openMine, { tab: 'practice', autostart: true }));
    bindBankDelete(view);
  }

  function contactLine(what) {
    const qq = (Q_CONFIG.contact && Q_CONFIG.contact.qq) || '';
    return qq ? ('没有' + what + '？加 QQ ' + esc(qq) + ' 定制') : ('没有' + what + '？可以自己导入，或联系我定制');
  }

  function marketCard(it) {
    const unlocked = isUnlocked(it);
    const price = it.price_cents || 100;
    const tag = it.kind === 'free'
      ? '<span class="tag ok">免费</span>'
      : (unlocked ? '<span class="tag gray">已解锁</span>' : '<span class="tag warn">¥' + yuan(price) + '</span>');
    return '<div class="mk-card' + (unlocked ? '' : ' locked') + '">'
      + '<div class="mk-card-top">' + tag + '<span class="tiny muted">' + it.chapter_count + ' 章</span></div>'
      + '<h4>' + esc(it.title) + '</h4>'
      + '<div class="mk-org">' + (it.org ? esc(it.org) : '&nbsp;') + '</div>'
      + '<div class="mk-card-foot"><span class="mk-count">' + Number(it.question_count || 0).toLocaleString('zh-CN') + '<small>题</small></span>'
      + '<button class="btn sm ' + 'catalog-action' + '" data-open="' + esc(it.id) + '" aria-label="' + esc((unlocked ? '开始练习：' : '解锁题库：') + it.title) + '">'
      + (unlocked ? '开始练习' : '¥' + yuan(price) + ' 解锁') + '<span aria-hidden="true">↗</span></button></div>'
      + '</div>';
  }

  function mineCard(b) {
    return '<div class="mk-card">'
      + '<div class="mk-card-top"><span class="tag gray">我的</span><span class="tiny muted">' + (b.courses || []).length + ' 门课</span></div>'
      + '<h4>' + esc(b.title) + '</h4>'
      + '<div class="mk-org">' + esc(b.subject || '本地导入') + '</div>'
      + '<div class="mk-card-foot"><span class="tiny muted">' + bankQCount(b) + ' 题</span>'
      + '<button class="btn sm" data-open-mine="' + esc(b.id) + '">开始练</button>'
      + '<button class="btn sm ghost danger" data-del="' + esc(b.id) + '">删除</button></div>'
      + '</div>';
  }

  function renderBanks() {
    const view = $('#view-banks');
    view.innerHTML = '<div class="card"><div class="card-head"><h2>我的题库</h2><div class="row">'
      + '<button class="btn primary" data-act="open-import">＋ 导入题库</button>'
      + '<button class="btn" data-act="go-market">去题库广场</button></div></div>'
      + '<p class="small muted" style="margin-top:-4px">支持 PDF / Word(.docx) / Markdown / 纯文本。导入及 AI 重新解析免费，不消耗 AI 次数。</p>'
      + '</div>'
      + '<div class="card">' + S.banks.map(b => {
        const tag = b.builtin ? '<span class="tag gray">内置示例</span>' : b.cloudId ? '<span class="tag ok">云端</span>' : '<span class="tag warn">仅本机</span>';
        const src = b.meta && b.meta.source_name ? b.meta.source_name : (b.source_name || '');
        return '<div class="bank-card"><div class="meta"><h4>' + esc(b.title) + tag + '</h4>'
          + '<p>' + bankQCount(b) + ' 题 · ' + (b.courses || []).length + ' 门课' + (src ? ' · 来自 ' + esc(src) : '') + (b.created_at ? ' · ' + fmtDate(b.created_at) : '') + '</p></div>'
          + '<div class="acts">'
          + (b.id !== S.bankId ? '<button class="btn sm" data-use="' + esc(b.id) + '">使用</button>' : '<span class="tag">使用中</span>')
          + (!b.cloudId && !b.builtin && C.session ? '<button class="btn sm soft" data-sync="' + esc(b.id) + '">同步到云端</button>' : '')
          + (b.cloudId ? '<button class="btn sm ghost" data-rename="' + esc(b.id) + '">重命名</button>' : '')
          + '<button class="btn sm ghost danger" data-del="' + esc(b.id) + '">删除</button>'
          + '</div></div>';
      }).join('') + '</div>';
    $$('[data-use]', view).forEach(b => b.onclick = () => selectBank(b.dataset.use));
    bindBankDelete(view);
    $$('[data-sync]', view).forEach(b => b.onclick = async () => {
      const bank = S.banks.find(x => x.id === b.dataset.sync);
      if (!bank) return;
      if (!C.session) { openAuth('login', '同步题库需要先登录'); return; }
      try {
        const row = await C.createBank({
          title: bank.title, subject: bank.subject, source_kind: bank.meta && bank.meta.source_kind || 'manual',
          source_name: bank.meta && bank.meta.source_name || '本机导入', data: { courses: bank.courses, meta: bank.meta }, question_count: bankQCount(bank)
        });
        const oldId = bank.id;
        const progress = localProgressMap(), notes = localNotesMap();
        if (progress[oldId]) await C.saveProgress(row.id, progress[oldId]);
        bank.id = 'c' + row.id; bank.cloudId = row.id; bank.local = false;
        if (progress[oldId]) { progress[bank.id] = progress[oldId]; delete progress[oldId]; writeLS(LS.progress, progress); }
        if (notes[oldId]) { notes[bank.id] = notes[oldId]; delete notes[oldId]; writeLS(LS.notes, notes); }
        if (S.bankId === oldId) { S.bankId = bank.id; writeLS(LS.selected, bank.id); }
        saveLocalBanks();
        toast('已同步到云端', 'ok');
        renderBanks(); refreshBankSelect();
      } catch (e) { toast('同步失败：' + (e.message || '重试一次'), 'bad'); }
    });
    $$('[data-rename]', view).forEach(b => b.onclick = async () => {
      const bank = S.banks.find(x => x.id === b.dataset.rename);
      const t = prompt('新的题库名称', bank.title);
      if (!t || t === bank.title) return;
      try { await C.renameBank(bank.cloudId, t.trim()); bank.title = t.trim(); renderBanks(); refreshBankSelect(); }
      catch (e) { toast('改名失败', 'bad'); }
    });
    bindActs(view);
  }

  function bindBankDelete(view) {
    $$('[data-del]', view).forEach(b => b.onclick = async () => {
      const bank = S.banks.find(x => x.id === b.dataset.del);
      if (!bank || !confirm(bank.builtin
        ? '从我的题库移除「' + bank.title + '」并清除练习记录？之后仍可从题库广场重新添加。'
        : '删除「' + bank.title + '」？题目和记录都会一起删除。')) return;
      try {
        if (bank.cloudId && !(await C.deleteBank(bank.cloudId))) throw new Error('云端没有确认删除，请重试');
        if (bank.cloudId) { const pending = dirtyMap(); delete pending[dirtyKey(bank)]; writeLS(LS.dirty, pending); }
        S.banks = S.banks.filter(x => x.id !== bank.id);
        saveLocalBanks();
        saveCatalogBanks(bank.catalogId);
        const progress = localProgressMap(), notes = localNotesMap();
        delete progress[bank.id]; delete notes[bank.id];
        writeLS(LS.progress, progress); writeLS(LS.notes, notes);
        if (S.bankId === bank.id) {
          S.bankId = S.banks[0] ? S.banks[0].id : null;
          writeLS(LS.selected, S.bankId);
          S.pq = []; S.pi = 0;
          await loadProgressFor(curBank()); await loadNotesFor(curBank());
        }
        render(); toast('已删除');
      } catch (e) { toast('删除失败：' + (e.message || '请重试'), 'bad'); }
    });
  }

  /* ================= 我的 ================= */
  async function renderAccount() {
    const view = $('#view-account');
    if (!C.session) {
      view.innerHTML = '<div class="card"><div class="empty"><div class="ico"></div><h3>登录后，题库和余额跟着账号走</h3>'
        + '<p>注册免费送 1 次 AI 整理知识点。登录才能解锁收费题库、充值、跨设备同步进度。</p>'
        + '<div class="row" style="justify-content:center"><button class="btn primary" data-act="open-login">登录</button>'
        + '<button class="btn" data-act="open-register">注册</button></div></div></div>'
        + '<div class="card"><div class="card-title" style="margin-bottom:8px">为什么要登录</div>'
        + '<ul class="small muted" style="margin:0;padding-left:20px;line-height:1.9">'
        + '<li>收费题库要解锁到你的账号上，换设备不用重复付钱</li>'
        + '<li>兑换码需要登录后使用，直接兑换到当前账号</li>'
        + '<li>练习进度、错题本、知识点存云端，换浏览器接着练</li></ul></div>';
      bindActs(view); return;
    }
    const p = C.profile || { credits: 0, total_spent: 0, balance_cents: 0 };
    const unlockedN = Object.keys(S.unlocks).length;
    view.innerHTML = '<div class="card"><div class="card-head"><div><div class="card-title">' + esc(C.currentEmail()) + '</div>'
      + '<div class="tiny muted">已登录 · 数据自动同步</div></div>'
      + '<button class="btn sm ghost" id="logoutBtn">退出登录</button></div>'
      + '<div class="grid three"><div class="stat"><b>¥' + yuan(p.balance_cents || 0) + '</b><span>账户余额</span></div>'
      + '<div class="stat"><b>' + (p.credits || 0) + '</b><span>AI 可用次数</span></div>'
      + '<div class="stat"><b>' + unlockedN + '</b><span>已解锁题库</span></div></div>'
      + '<div class="row" style="margin-top:14px"><button class="btn primary" id="rechargeBtn">兑换码充值</button><button class="btn" id="refreshAccountBtn">刷新账户</button>'
      + '<button class="btn" data-act="go-market">去题库解锁</button></div></div>'
      + '<div class="card"><p class="small muted" style="margin:0">余额用于解锁付费题库或换取 AI 次数；AI 次数用于 AI 功能。次数码不增加人民币余额。</p>' + redeemContactHtml() + '</div>'
      + '<div class="card"><div class="card-head"><h2>消耗记录</h2></div><div id="usageList" class="small muted">加载中…</div></div>';

    $('#logoutBtn').onclick = async () => {
      await flushProgressSave();
      await C.signOut(); S.exam = null; S.unlocks = {};
      S.banks = []; S.bankId = null; S.db = defaultDb();
      await mergeBanks(); await loadCatalog(); S.tab = 'market'; render(); toast('已退出');
    };
    $('#rechargeBtn').onclick = () => openRecharge(null, 0);
    $('#refreshAccountBtn').onclick = async () => {
      const btn = $('#refreshAccountBtn'); btn.disabled = true;
      const refreshed = await C.reloadProfile();
      if (refreshed) { refreshBankSelect(); renderAccount(); toast('账户已刷新', 'ok'); }
      else { toast('账户暂时无法刷新，请稍后重试', 'bad'); btn.disabled = false; }
    };

    bindActs(view);
    try {
      const list = await C.usageList(30);
      const box = $('#usageList');
      if (!box) return;
      const labels = { ai_import: 'AI 解析题库', ai_notes: 'AI 生成知识点' };
      const rows = list.map(u => '<div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)">'
        + '<span>' + esc(labels[u.action] || u.action) + (u.note ? ' · ' + esc(u.note) : '') + (u.refunded ? ' <span class="tag gray">已退回</span>' : '') + '</span>'
        + '<span class="tiny muted">-' + u.cost + ' 次 · ' + fmtDate(u.created_at) + '</span></div>').join('');
      const orders = await C.orderList(10);
      const oRows = orders.map(o => '<div class="row" style="justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)">'
        + '<span>' + (o.amount_cents ? '余额码兑换 ' : 'AI 次数码兑换 ') + '<span class="mono tiny muted">' + esc(o.code || '') + '</span></span>'
        + '<span class="tiny" style="color:var(--ok)">+' + (o.amount_cents ? '¥' + yuan(o.amount_cents) : (o.credits || 0) + ' 次') + ' · ' + fmtDate(o.created_at) + '</span></div>').join('');
      box.innerHTML = (rows || (orders.length ? '' : '还没有消耗记录。'))
        + (orders.length ? '<div class="card-title" style="margin:14px 0 4px">兑换记录</div>' + oRows : '');
    } catch (e) { }
  }

  function contactQq() {
    return ((window.Q_CONFIG || {}).contact || {}).qq || '';
  }

  /** 获取兑换码的固定联系入口，沿用原配置中的 QQ。 */
  function redeemContactHtml() {
    const qq = contactQq();
    return '<div class="redeem-contact"><b>需要兑换码？请联系我</b><span>'
      + (qq ? 'QQ：<span class="mono">' + esc(qq) + '</span>' : '请联系我获取兑换码')
      + '</span></div>';
  }

  /** 充值只核销兑换码；不创建支付订单。 */
  function openRecharge(item, needCents) {
    if (!C.session) { openAuth('login', '请先登录，再使用兑换码充值'); return; }
    track('recharge_open', { bank: item ? item.id : null, p: { need: needCents || 0, balance: balCents() } });
    openModal('<div class="modal-head"><h3>兑换码充值</h3><button class="x" data-close aria-label="关闭">×</button></div>'
      + '<div class="modal-body">'
      + '<div class="balance-bar"><div><span class="tiny muted">账户余额</span><b id="redeemBalance">¥' + yuan(balCents()) + '</b></div>'
      + '<div><span class="tiny muted">AI 可用次数</span><b id="redeemCredits">' + (credits() || 0) + ' 次</b></div></div>'
      + (item ? '<div class="banner"><div class="grow">解锁「' + esc(item.title) + '」需要账户余额 ¥' + yuan(item.price_cents || 100) + '。请使用余额码充值。</div></div>' : '')
      + '<p class="small muted">余额码增加账户金额；AI 次数码只增加 AI 次数，兑换后金额不变。有效兑换码直接到账，无需人工确认。</p>'
      + '<label class="field" for="codeInput"><span>兑换码</span><input id="codeInput" type="text" placeholder="输入兑换码，如 ABCD-EFGH-IJKL" autocomplete="off" spellcheck="false" maxlength="128" style="text-transform:uppercase"></label>'
      + '<button class="btn primary block" id="doRedeem">立即兑换</button>'
      + '<div id="redeemResult" role="status" aria-live="polite"></div>'
      + redeemContactHtml()
      + '</div>');
    const input = $('#codeInput'), btn = $('#doRedeem'), result = $('#redeemResult');
    let busy = false, redeemed = false;
    function paintBalances() {
      $('#redeemBalance').textContent = C.profile ? '¥' + yuan(balCents()) : '待刷新';
      $('#redeemCredits').textContent = C.profile ? (credits() || 0) + ' 次' : '待刷新';
    }
    function successActions(pending) {
      result.innerHTML = '<div class="fb ' + (pending ? '' : 'ok') + '"><b>兑换已成功，无需再次输入此码。</b><br>'
        + (pending ? '账户数据暂未刷新，请点击下方「刷新到账结果」，不会重复兑换。' : '账户余额和 AI 次数已更新。次数码兑换后，人民币金额保持不变。')
        + '</div><div class="row" style="margin-top:12px"><button class="btn" id="redeemRefresh">刷新到账结果</button>'
        + '<button class="btn primary" id="redeemDone">完成</button></div>';
      $('#redeemDone').onclick = closeModal;
      $('#redeemRefresh').onclick = async () => {
        const refresh = $('#redeemRefresh'); refresh.disabled = true;
        const p = await C.reloadProfile();
        // The user may close the dialog while the read is in flight.
        if (!result.isConnected) return;
        paintBalances();
        if (p) { refreshBankSelect(); render(); successActions(false); }
        else { refresh.disabled = false; toast('暂时无法刷新，请稍后查看「我的」兑换记录', 'bad'); }
      };
    }
    async function submitCode() {
      if (busy || redeemed) return;
      if (!input.value.trim()) { result.textContent = '请先输入兑换码。'; input.focus(); return; }
      busy = true; btn.disabled = true; btn.textContent = '兑换中…'; result.textContent = '';
      try {
        const r = await C.recharge(input.value);
        if (!result.isConnected) return;
        if (!r || !r.ok) {
          const messages = { invalid: '兑换码无效或已被使用，请核对后重试。', used: '此兑换码已被使用，请查看账户和兑换记录。', expired: '兑换码已过期，请联系我处理。' };
          track('redeem_fail', { ok: false, p: { reason: (r && r.reason) || 'unknown' } });
          result.textContent = messages[r && r.reason] || '本次未能兑换，请核对兑换码或联系我。';
          return;
        }
        redeemed = true; input.disabled = true; btn.textContent = '已兑换';
        track('redeem_success', { ok: true, p: { amount: r.amount_cents || 0, credits: r.credits || 0 } });
        paintBalances(); refreshBankSelect(); render(); successActions(!!r.refresh_pending);
      } catch (e) {
        if (result.isConnected) result.textContent = '未能确认兑换结果：' + (e.message || '网络异常') + '。请先刷新账户及兑换记录，避免连续重试。';
      } finally {
        busy = false;
        if (!redeemed && btn.isConnected) { btn.disabled = false; btn.textContent = '立即兑换'; }
      }
    }
    btn.onclick = submitCode;
    input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitCode(); } };
    input.focus();
  }

  /* ================= 弹层 ================= */
  function openModal(html, wide) {
    const ov = $('#overlay');
    ov.innerHTML = '<div class="modal' + (wide ? ' wide' : '') + '">' + html + '</div>';
    ov.classList.remove('hide');
    ov.onclick = e => { if (e.target === ov) closeModal(); };
    $$('[data-close]', ov).forEach(b => b.onclick = closeModal);
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    $('#overlay').classList.add('hide');
    $('#overlay').innerHTML = '';
    document.body.style.overflow = '';
  }

  function openAuth(mode, reason) {
    S.pendingLoginReason = reason || '';
    track('auth_open', { p: { mode: mode === 'register' ? 'register' : 'login' } });
    const m = mode === 'register' ? 'register' : 'login';
    openModal('<div class="modal-head"><h3>' + (m === 'register' ? '注册账号' : '登录') + '</h3><button class="x" data-close>×</button></div>'
      + '<div class="modal-body">'
      + (reason ? '<div class="banner"><div class="grow">' + esc(reason) + '</div></div>' : '')
      + '<div class="seg" style="margin-bottom:14px"><button data-mode="login" class="' + (m === 'login' ? 'on' : '') + '">登录</button><button data-mode="register" class="' + (m === 'register' ? 'on' : '') + '">注册</button></div>'
      + '<div id="authBody"></div></div>');
    $$('[data-mode]').forEach(b => b.onclick = () => openAuth(b.dataset.mode, reason));
    renderAuthBody(m, 'password');
  }

  function renderAuthBody(mode, method) {
    const box = $('#authBody');
    if (!box) return;
    if (mode === 'login') {
      box.innerHTML = '<div class="seg" style="margin-bottom:12px"><button data-m="password" class="' + (method === 'password' ? 'on' : '') + '">密码登录</button><button data-m="otp" class="' + (method === 'otp' ? 'on' : '') + '">验证码登录</button></div>'
        + '<label class="field"><span>邮箱</span><input id="auEmail" type="email" placeholder="you@example.com" autocomplete="email"></label>'
        + (method === 'password'
          ? '<label class="field"><span>密码</span><input id="auPass" type="password" placeholder="密码" autocomplete="current-password"></label>'
            + '<div class="row" style="justify-content:space-between"><button class="btn ghost sm" id="forgot">忘记密码？</button><button class="btn primary" id="doLogin">登录</button></div>'
          : '<label class="field"><span>验证码</span><div class="row"><input class="grow" id="auCode" placeholder="6 位验证码"><button class="btn" id="sendCode">发送验证码</button></div></label>'
            + '<button class="btn primary block" id="doOtp">登录</button>')
        + '<p class="tiny muted" style="margin-bottom:0">不收集手机号，只用邮箱做账号。登录状态保存在本机。</p>';
    } else if (mode === 'register') {
      box.innerHTML = '<label class="field"><span>邮箱</span><div class="row"><input class="grow" id="auEmail" type="email" placeholder="you@example.com"><button class="btn" id="sendCode">发验证码</button></div></label>'
        + '<label class="field"><span>验证码</span><input id="auCode" placeholder="邮箱收到的 6 位验证码"></label>'
        + '<label class="field"><span>设置密码</span><input id="auPass" type="password" placeholder="至少 6 位，用于以后登录"></label>'
        + '<button class="btn primary block" id="doRegister">注册并登录</button>'
        + '<p class="tiny muted" style="margin-bottom:0">注册即送 1 次 AI 额度。已有账号请切到「登录」。</p>';
    } else {
      box.innerHTML = '<p class="small" style="margin-top:0">输入注册邮箱，收到验证码后设置新密码。</p>'
        + '<label class="field"><span>邮箱</span><div class="row"><input class="grow" id="auEmail" type="email" placeholder="you@example.com"><button class="btn" id="sendReset">发送验证码</button></div></label>'
        + '<label class="field"><span>验证码</span><input id="auCode" placeholder="6 位验证码"></label>'
        + '<label class="field"><span>新密码</span><input id="auPass" type="password" placeholder="至少 6 位"></label>'
        + '<button class="btn primary block" id="doReset">重设密码</button>'
        + '<button class="btn ghost block" id="backLogin" style="margin-top:8px">返回登录</button>';
    }
    $$('[data-m]', box).forEach(b => b.onclick = () => renderAuthBody('login', b.dataset.m));
    if ($('#forgot')) $('#forgot').onclick = () => renderAuthBody('forgot');
    if ($('#backLogin')) $('#backLogin').onclick = () => renderAuthBody('login');
    if ($('#sendCode')) $('#sendCode').onclick = () => sendCode($('#auEmail').value, mode);
    if ($('#sendReset')) $('#sendReset').onclick = () => sendReset($('#auEmail').value);
    if ($('#doLogin')) $('#doLogin').onclick = doPasswordLogin;
    if ($('#doOtp')) $('#doOtp').onclick = doOtpLogin;
    if ($('#doRegister')) $('#doRegister').onclick = doRegister;
    if ($('#doReset')) $('#doReset').onclick = doReset;
    if ($('#auPass')) $('#auPass').onkeydown = e => { if (e.key === 'Enter' && mode === 'login') doPasswordLogin(); };
  }

  async function sendCode(email, mode) {
    if (!email || email.indexOf('@') < 0) { toast('先填一个邮箱'); return; }
    const btn = $('#sendCode');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
      const r = await C.sendOtp(email.trim());
      S._signup = { email: email.trim(), verificationId: r.verificationId, isExistingUser: r.isExistingUser };
      toast('验证码已发送，查收邮箱', 'ok');
      btn.textContent = '重新发送(60s)';
      let n = 60;
      const t = setInterval(() => { n--; if (n <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = '发送验证码'; } else btn.textContent = '重新发送(' + n + 's)'; }, 1000);
    } catch (e) {
      btn.disabled = false; btn.textContent = '发送验证码';
      toast(errText(e), 'bad');
    }
  }

  async function doPasswordLogin() {
    const email = $('#auEmail').value.trim(), pass = $('#auPass').value;
    if (!email || !pass) { toast('邮箱和密码都要填'); return; }
    const btn = $('#doLogin'); btn.disabled = true; btn.textContent = '登录中…';
    try {
      await C.signInPassword(email, pass);
      closeModal(); onLoggedIn();
    } catch (e) {
      btn.disabled = false; btn.textContent = '登录';
      toast(errText(e), 'bad');
    }
  }

  async function doOtpLogin() {
    const email = $('#auEmail').value.trim(), code = $('#auCode').value.trim();
    if (!email || !code) { toast('邮箱和验证码都要填'); return; }
    const s = S._signup;
    if (!s || s.email !== email) { toast('请先点「发送验证码」'); return; }
    const btn = $('#doOtp'); btn.disabled = true; btn.textContent = '登录中…';
    try {
      await C.verifyOtp({ email, code, verificationId: s.verificationId, isExistingUser: s.isExistingUser });
      closeModal(); onLoggedIn();
    } catch (e) {
      btn.disabled = false; btn.textContent = '登录';
      toast(errText(e), 'bad');
    }
  }

  async function doRegister() {
    const email = $('#auEmail').value.trim(), code = $('#auCode').value.trim(), pass = $('#auPass').value;
    if (!email || !code || !pass) { toast('邮箱、验证码、密码都要填'); return; }
    if (pass.length < 6) { toast('密码至少 6 位'); return; }
    const btn = $('#doRegister'); btn.disabled = true; btn.textContent = '注册中…';
    try {
      const s = S._signup;
      if (!s || s.email !== email) { toast('请先点「发验证码」'); btn.disabled = false; btn.textContent = '注册并登录'; return; }
      await C.verifySignup({ email, code, password: pass, verificationId: s.verificationId, isExistingUser: s.isExistingUser });
      closeModal(); onLoggedIn(true);
    } catch (e) {
      btn.disabled = false; btn.textContent = '注册并登录';
      toast(errText(e), 'bad');
    }
  }

  async function sendReset(email) {
    if (!email || email.indexOf('@') < 0) { toast('先填邮箱'); return; }
    const btn = $('#sendReset'); btn.disabled = true; btn.textContent = '发送中…';
    try {
      const handle = await C.beginReset(email.trim());
      S._reset = { email: email.trim(), handle };
      toast('验证码已发送', 'ok');
      btn.textContent = '已发送';
    } catch (e) {
      btn.disabled = false; btn.textContent = '发送验证码';
      toast(errText(e), 'bad');
    }
  }

  async function doReset() {
    const code = $('#auCode').value.trim(), pass = $('#auPass').value;
    if (!S._reset || !code || !pass) { toast('先获取验证码并填新密码'); return; }
    try {
      const r = await S._reset.handle.updateUser({ nonce: code, password: pass });
      if (r.error) throw r.error;
      closeModal(); onLoggedIn();
      toast('密码已重设并登录', 'ok');
    } catch (e) { toast(errText(e), 'bad'); }
  }

  function errText(e) {
    const msg = (e && (e.message || (e.error && e.error.message))) || '';
    if (/invalid|wrong|密码|password/i.test(msg)) return '账号或密码不对';
    if (/otp|verif|验证码/i.test(msg)) return '验证码不对或已过期';
    if (/network|fetch/i.test(msg)) return '网络不稳定，重试一下';
    return msg || '操作失败，请重试';
  }

  async function onLoggedIn(isNew) {
    await mergeBanks();
    await loadCatalog();
    await restoreCatalogBanks();
    await loadProgressFor(curBank());
    await loadNotesFor(curBank());
    refreshBankSelect();
    render();
    const locals = S.banks.filter(b => b.local && !b.builtin && !b.cloudId);
    if (locals.length) {
      toast('已登录。有 ' + locals.length + ' 个本机题库可以点「同步到云端」', 'ok');
    } else {
      toast(isNew ? '注册成功，已送 1 次 AI 额度' : '登录成功', 'ok');
    }
  }

  /* ================= 导入 ================= */
  function openImport() {
    const imp = { step: 1, text: '', name: '', kind: '', parsed: null, title: '', subject: '', aiUsed: false, usageId: null, busy: false };
    S._imp = imp;
    openModal(importHtml(imp), true);
    bindImport();
  }

  function importHtml(imp) {
    return '<div class="modal-head"><h3>导入题库</h3><button class="x" data-close>×</button></div>'
      + '<div class="modal-body">'
      + '<div class="steps"><span class="s"><b>1</b> 选择内容</span><span class="s"><b>2</b> 解析预览</span><span class="s"><b>3</b> 保存</span></div>'
      + '<div id="impBody">' + importStep1(imp) + '</div></div>'
      + '<div class="modal-foot" id="impFoot"><button class="btn" data-close>取消</button></div>';
  }

  function importStep1(imp) {
    return '<div class="seg" style="margin-bottom:12px"><button class="on" data-src="file">上传文件</button><button data-src="text">粘贴文字</button></div>'
      + '<div id="srcFile"><div class="dropzone" id="dropzone"><div class="big"></div><div style="font-weight:600;margin-bottom:4px">把文件拖进来，或点击选择</div>'
      + '<div class="tiny muted">PDF · DOCX · MD · TXT，单个文件不超过 25MB</div>'
      + '<input type="file" id="fileInput" accept=".pdf,.docx,.md,.markdown,.txt" style="display:none"></div>'
      + '<p class="tiny muted" style="margin:10px 0 0">扫描版 PDF 没有文字层，读不出来；请在 PDF 工具里先 OCR，或直接粘贴文字。</p></div>'
      + '<div id="srcText" class="hide"><textarea id="pasteText" placeholder="把题目粘到这里，格式大概是：&#10;1. 管理的四大职能包括（ ）&#10;A. 计划 B. 组织&#10;C. 领导 D. 控制&#10;答案：ABCD&#10;解析：……"></textarea>'
      + '<button class="btn primary block" id="parsePaste" style="margin-top:10px">解析这段文字</button></div>';
  }

  function bindImport() {
    const imp = S._imp;
    const ov = $('#overlay');
    $$('[data-src]', ov).forEach(b => b.onclick = () => {
      $$('[data-src]', ov).forEach(x => x.classList.toggle('on', x === b));
      $('#srcFile').classList.toggle('hide', b.dataset.src !== 'file');
      $('#srcText').classList.toggle('hide', b.dataset.src !== 'text');
    });
    const dz = $('#dropzone'), fi = $('#fileInput');
    if (dz) {
      dz.onclick = () => fi.click();
      dz.ondragover = e => { e.preventDefault(); dz.classList.add('drag'); };
      dz.ondragleave = () => dz.classList.remove('drag');
      dz.ondrop = e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) readFileForImport(e.dataTransfer.files[0]); };
      fi.onchange = () => { if (fi.files[0]) readFileForImport(fi.files[0]); };
    }
    if ($('#parsePaste')) $('#parsePaste').onclick = () => {
      const text = $('#pasteText').value.trim();
      if (text.length < 20) { toast('内容太短，至少粘几道题'); return; }
      const parsed = P.fromText(text, '');
      imp.text = text; imp.name = '粘贴的文字'; imp.kind = 'txt'; imp.parsed = parsed; imp.title = parsed.title;
      gotoImportPreview();
    };
  }

  async function readFileForImport(file) {
    const imp = S._imp;
    const body = $('#impBody');
    body.innerHTML = '<div style="text-align:center;padding:30px 0"><span class="spinner"></span> <span id="readProg">正在读取文件…</span></div>';
    try {
      const r = await P.readFile(file, (p, t) => { const el = $('#readProg'); if (el) el.textContent = '正在提取 PDF 第 ' + p + ' / ' + t + ' 页…'; });
      imp.text = r.text; imp.name = r.name; imp.kind = r.kind;
      imp.parsed = P.fromText(r.text, r.name);
      imp.title = imp.parsed.title || r.name.replace(/\.[^.]+$/, '');
      gotoImportPreview();
    } catch (e) {
      body.innerHTML = '<div class="banner bad">' + esc(e.message || '读取失败') + '</div>' + importStep1(imp);
      bindImport();
    }
  }

  function gotoImportPreview() {
    const imp = S._imp;
    const body = $('#impBody'), foot = $('#impFoot');
    const st = imp.parsed.stats;
    const warn = imp.parsed.warnings.length
      ? '<div class="banner warn"><div class="grow">' + imp.parsed.warnings.map(esc).join('；') + '</div></div>' : '';
    const sample = [];
    imp.parsed.chapters.slice(0, 2).forEach(ch => ch.qs.slice(0, 2).forEach(q => {
      sample.push('<div class="qitem"><div class="t">' + esc(q.stem) + '</div>'
        + (q.options.length ? '<div class="small muted">' + q.options.map(o => esc(o.k) + '. ' + esc(o.v)).join('　') + '</div>' : '')
        + '<div class="small"><b>答案：' + esc(q.answer || '未识别') + '</b></div></div>');
    }));
    body.innerHTML = '<div class="grid two" style="margin-bottom:12px">'
      + '<label class="field"><span>题库名称</span><input id="impTitle" value="' + esc(imp.title) + '"></label>'
      + '<label class="field"><span>科目（可选）</span><input id="impSubject" placeholder="如：管理学"></label></div>'
      + warn
      + '<div class="row" style="margin-bottom:10px"><span class="tag">' + st.total + ' 题</span><span class="tag gray">' + st.chapters + ' 节</span>'
      + '<span class="tag gray">单选 ' + (st.byType['单选题'] || 0) + '</span><span class="tag gray">多选 ' + (st.byType['多选题'] || 0) + '</span>'
      + '<span class="tag gray">判断 ' + (st.byType['判断题'] || 0) + '</span>'
      + '<span class="tag ' + (st.noAnswer ? 'warn' : 'ok') + '">有答案 ' + st.withAnswer + ' / ' + st.total + '</span></div>'
      + '<div style="max-height:240px;overflow:auto">' + (sample.join('') || '<p class="small muted">没有识别出题目</p>') + '</div>'
      + '<div class="banner" style="margin-top:12px"><div class="grow">识别不准？可免费用 AI 重新解析完整文本；原文没有的答案不会编造，不消耗 AI 次数。</div></div>';
    foot.innerHTML = '<button class="btn" id="impBack">重新选择</button>'
      + '<button class="btn" id="impAI">免费 AI 重新解析</button>'
      + '<button class="btn primary" id="impSave"' + (st.total ? '' : ' disabled') + '>保存题库</button>';
    $('#impTitle').oninput = e => { imp.title = e.target.value; };
    $('#impSubject').oninput = e => { imp.subject = e.target.value; };
    $('#impBack').onclick = () => openImport();
    $('#impSave').onclick = saveImportedBank;
    $('#impAI').onclick = aiReparse;
  }

  async function aiReparse() {
    const imp = S._imp;
    if (imp.busy) return;
    if (!C.session) { openAuth('login', '登录后即可免费使用 AI 重新解析'); return; }
    imp.busy = true;
    const foot = $('#impFoot');
    const body = $('#impBody');
    foot.innerHTML = '<button class="btn" id="impCancelAI">取消</button>';
    body.innerHTML = '<div style="text-align:center;padding:24px 0"><span class="spinner"></span><div id="aiProg" class="small muted" style="margin-top:10px">准备中…</div>'
      + '<div class="progress" style="max-width:320px;margin:12px auto"><i id="aiBar" style="width:5%"></i></div>'
      + '<div class="tiny muted">长文档会逐段解析，请保持页面打开</div></div>';
    const ctrl = new AbortController();
    if ($('#impCancelAI')) $('#impCancelAI').onclick = () => ctrl.abort();
    try {
      const out = await AI.parseBank(imp.text, {
        signal: ctrl.signal,
        onProgress: (i, n, msg) => {
          const p = $('#aiProg'); if (p) p.textContent = msg;
          const bar = $('#aiBar'); if (bar) bar.style.width = ((i + 1) / n * 90) + '%';
        }
      });
      imp.parsed = { title: imp.title, subject: imp.subject, chapters: out.chapters,
        stats: statsFromChapters(out.chapters), warnings: out.warnings || [] };
      imp.aiUsed = true;
      imp.busy = false;
      gotoImportPreview();
      toast('AI 解析完成，共 ' + out.total + ' 题', 'ok');
    } catch (e) {
      imp.busy = false;
      toast('AI 解析失败：' + (e.message || '请重试') + '，原有解析结果仍可保存', 'bad');
      gotoImportPreview();
    }
  }

  function statsFromChapters(chapters) {
    let total = 0, withAnswer = 0;
    const byType = { 单选题: 0, 多选题: 0, 判断题: 0 };
    chapters.forEach(ch => ch.qs.forEach(q => {
      total++; if (q.answer) withAnswer++;
      byType[q.type] = (byType[q.type] || 0) + 1;
    }));
    return { total, withAnswer, noAnswer: total - withAnswer, chapters: chapters.length, byType };
  }

  async function saveImportedBank() {
    const imp = S._imp;
    const title = ($('#impTitle') && $('#impTitle').value.trim()) || imp.title || '我的题库';
    const subject = ($('#impSubject') && $('#impSubject').value.trim()) || '';
    const bank = P.makeBank({ title, subject, chapters: imp.parsed.chapters, source_kind: imp.aiUsed ? 'ai' : imp.kind, source_name: imp.name });
    bank.question_count = P.countQuestions(bank);
    if (!bank.question_count) { toast('没有题目可保存'); return; }
    const btn = $('#impSave');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      if (C.session) {
        const row = await C.createBank({
          title, subject, source_kind: bank.meta.source_kind, source_name: imp.name,
          data: { courses: bank.courses, meta: bank.meta }, question_count: bank.question_count
        });
        bank.id = 'c' + row.id; bank.cloudId = row.id; bank.local = false;
      } else {
        bank.id = uid(); bank.local = true;
      }
      S.banks.push(bank);
      if (bank.local) saveLocalBanks();
      closeModal();
      await selectBank(bank.id);
      S.tab = 'practice'; S.pq = []; render();
      toast('题库已保存，共 ' + bank.question_count + ' 题', 'ok');
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '保存题库'; }
      toast('保存失败：' + (e.message || '重试一次'), 'bad');
    }
  }

  /* ================= AI 生成知识点 ================= */
  async function generateNotes() {
    const bank = curBank();
    if (!bank) return;
    if (!C.session) { openAuth('login', '生成知识点需要登录，注册送 1 次'); return; }
    const cost = costOf('ai_notes');
    if (credits() < cost) { openPaywall('ai_notes'); return; }
    const chapters = (curCourse() || {}).chapters || [];
    if (!chapters.length) { toast('这个题库没有题目'); return; }
    openModal('<div class="modal-head"><h3>生成知识点</h3><button class="x" data-close>×</button></div>'
      + '<div class="modal-body" style="text-align:center;padding:30px 18px"><span class="spinner"></span>'
      + '<div class="small muted" id="ntProg" style="margin-top:10px">正在读取 ' + chapters.length + ' 个章节的题目…</div>'
      + '<div class="tiny muted" id="ntCount" style="margin-top:6px"></div></div>');
    let spent = null;
    try {
      const r = await C.spend('ai_notes', bank.title);
      if (!r || !r.ok) { openPaywall('ai_notes'); return; }
      track('ai_use', { p: { action: 'ai_notes' } });
      spent = r.usage_id;
      refreshBankSelect();
      let chars = 0;
      const html = await AI.generateNotes({
        title: bank.title, chapters,
        onDelta: (d, all) => {
          chars = all.length;
          const c = $('#ntCount'); if (c) c.textContent = '已生成 ' + chars + ' 字';
          const p = $('#ntProg'); if (p) p.textContent = '正在归纳章节重点…';
        }
      });
      const title = bank.title + ' · 知识点手册';
      if (bank.cloudId) {
        const row = await C.createNote({ bank_id: bank.cloudId, title, content_html: html });
        S.notes = [row];
      } else {
        S.notes = [{ id: 'local', title, content_html: html, created_at: null }];
        saveLocalNotes();
      }
      closeModal();
      S.tab = 'notes';
      render();
      toast('知识点已生成', 'ok');
    } catch (e) {
      if (spent) { try { await C.refund(spent); } catch (x) {} }
      closeModal();
      toast('生成失败：' + (e.message || '重试一次') + (spent ? '（次数已退回）' : ''), 'bad');
      renderNotes();
    }
  }

  /* ================= 付费墙 ================= */
  function openPaywall(action) {
    if (!C.session) { openAuth('login', '这一步需要登录，注册送 1 次 AI 整理知识点'); return; }
    const need = costOf(action);
    const have = credits();
    const price = 100;
    openModal('<div class="modal-head"><h3>AI 次数用完了</h3><button class="x" data-close>×</button></div>'
      + '<div class="modal-body"><div class="grid two"><div class="stat"><b>' + have + '</b><span>剩余次数</span></div>'
      + '<div class="stat"><b>' + need + '</b><span>本次需要</span></div></div>'
      + '<p class="small muted">注册送的 1 次已经用掉了。AI 整理知识点按 ¥' + yuan(price) + ' / 次，可以从余额里直接买。'
      + '余额不足可使用余额码充值；也可联系我获取 AI 次数码直接增加次数。</p>'
      + '<div class="unlock-row"><span>当前余额</span><b>¥' + yuan(balCents()) + '</b></div>'
      + '</div><div class="modal-foot"><button class="btn" data-close>稍后再说</button>'
      + '<button class="btn primary" id="pwBuy">用余额买 ' + need + ' 次（¥' + yuan(price * need) + '）</button></div>');
    $('#pwBuy').onclick = async () => {
      const btn = $('#pwBuy');
      btn.disabled = true; btn.textContent = '处理中…';
      try {
        const r = await C.buyCredits(need);
        if (!r || !r.ok) {
          closeModal();
          if (r && r.reason === 'insufficient') openRecharge(null, price * need);
          else toast('购买失败', 'bad');
          return;
        }
        closeModal();
        toast('已买 ' + need + ' 次', 'ok');
        refreshBankSelect(); render();
      } catch (e) {
        btn.disabled = false; btn.textContent = '重试';
        toast('购买失败：' + (e.message || ''), 'bad');
      }
    };
  }

  /* ================= 全局事件 ================= */
  function bindActs(root) {
    $$('[data-act]', root || document).forEach(el => {
      const act = el.dataset.act;
      if (el._bound) return;
      el._bound = true;
      el.onclick = (e) => {
        e.preventDefault();
        if (act === 'open-import') openImport();
        if (act === 'go-market') { S.tab = 'market'; render(); }
        if (act === 'reload-catalog') { loadCatalog().then(renderMarket); }
        if (act === 'open-login') openAuth('login');
        if (act === 'open-register') openAuth('register');
        if (act === 'gen-notes') generateNotes();
        if (act === 'del-note') {
          const id = el.dataset.id;
          if (!confirm('删除这份知识点？')) return;
          (async () => {
            try {
              if (id !== 'local') await C.deleteNote(id);
              S.notes = []; if (id === 'local') saveLocalNotes(); else { const map = localNotesMap(); delete map[S.bankId]; writeLS(LS.notes, map); }
              renderNotes(); toast('已删除');
            } catch (err) { toast('删除失败', 'bad'); }
          })();
        }
      };
    });
  }

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    localStorage.setItem(LS.theme, t);
    $('#themeBtn').innerHTML = t === 'dark'
      ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>'
      : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M20 15a9 9 0 0 1-11-11A9 9 0 1 0 20 15Z"/></svg>';
    $('#themeBtn').setAttribute('aria-label', t === 'dark' ? '切换为浅色模式' : '切换为深色模式');
  }

  function bindGlobal() {
    $('#navTabs').onclick = e => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      S.tab = b.dataset.tab;
      render();
      window.scrollTo({ top: 0 });
    };
    $('#bankSelect').onchange = e => selectBank(e.target.value);
    $('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    $('#creditBtn').onclick = () => { if (C.session) { S.tab = 'account'; render(); } else openAuth('login', '登录后查看 AI 次数'); };
    $('#userBtn').onclick = () => { S.tab = 'account'; render(); };

    document.addEventListener('keydown', e => {
      if ($('#overlay') && !$('#overlay').classList.contains('hide')) return;
      if (e.isComposing || e.key === 'Process' || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      if (S.tab !== 'practice' || !S.pq.length) return;
      const q = S.pq[S.pi];
      if (!q) return;
      const k = /^Key[A-HS]$/.test(e.code) ? e.code.slice(3) : e.key.toUpperCase();
      if (e.key === 'Enter') {
        if (tag === 'button' && (!e.target.matches('#optBox .opt') || (!S.pAnswered && q.type !== '多选题'))) return;
        e.preventDefault();
        if (S.pAnswered) nextPractice();
        else if (q.type === '多选题' && S.pSelected.length) answerPractice(S.pSelected);
        return;
      }
      if (k === 'S') { e.preventDefault(); toggleStar(q.id); $('#starBtn').classList.toggle('on', isStar(q.id)); return; }
      if (e.key === 'ArrowRight' && S.pAnswered) { nextPractice(); return; }
      if (e.key === 'ArrowLeft' && S.pi > 0) { S.pi--; renderPracticeQuestion(); return; }
      if (!S.pAnswered) {
        let key = k;
        if (/^[1-8]$/.test(k)) key = String.fromCharCode(64 + parseInt(k, 10));
        if (q.type === '判断题') key = key === 'A' ? '√' : key === 'B' ? 'X' : key;
        const valid = q.type === '判断题' ? ['√', 'X'] : q.options.map(o => o.k);
        if (valid.indexOf(key) >= 0) {
          e.preventDefault();
          const option = $$('#optBox .opt').find(b => b.dataset.opt === key);
          if (option) option.click();
        }
      }
    });

    window.addEventListener('online', () => { retryProgress(); if (S.bankId) loadProgressFor(curBank()).then(render); });
    setInterval(retryProgress, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        const map = localProgressMap(); if (S.bankId) { map[S.bankId] = S.db; writeLS(LS.progress, map); }
        flushProgressSave(); flushTrack();
      }
    });
    // 关页面/切走时把没发出去的事件补发一次
    window.addEventListener('pagehide', flushTrack);

    C.on('login', async () => { track('auth_success', { p: { users: 1 } }); await mergeBanks(); await loadCatalog(); await restoreCatalogBanks(); if (S.bankId) await selectBank(S.bankId); retryProgress(); render(); });
    C.on('auth', () => { refreshBankSelect(); });
    C.on('credits', () => { refreshBankSelect(); });
    bindActs(document);
  }

  /* ================= 访问埋点 ================= */
  // 只记「今天来过没有」：一个浏览器一个随机 id，不记 IP、不指纹、不关联账号。
  // 一次会话报一次（sessionStorage 挡重复），跨天重新计。
  function visitId() {
    let v = '';
    try { v = localStorage.getItem('qpb_vid') || ''; } catch (e) {}
    if (!/^[a-z0-9]{8,48}$/.test(v)) {
      v = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('qpb_vid', v); } catch (e) {}
    }
    return v;
  }
  function visitUa() {
    const ua = navigator.userAgent || '';
    if (/bot|crawler|spider|headless/i.test(ua)) return 'bot';
    if (/MicroMessenger/i.test(ua)) return 'wechat';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return 'mobile';
    return 'desktop';
  }
  function visitSrc() {
    const ref = document.referrer || '';
    if (!ref) return 'direct';
    try {
      const host = new URL(ref).hostname.replace(/^www\./, '');
      if (/(^|\.)qq\.com$/.test(host)) return 'qq';
      if (/(^|\.)(weixin|wechat)\.[a-z]+$/.test(host)) return 'wechat';
      if (host === location.hostname) return 'inner';
      return host.slice(0, 32);
    } catch (e) { return 'other'; }
  }
  function trackVisit() {
    try {
      const key = 'qpb_visit_' + todayKey();
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch (e) { return; }
    try { window.Q.cloud.pingVisit({ vid: visitId(), ua: visitUa(), src: visitSrc() }); } catch (e) {}
  }

  /* ================= 行为埋点 ================= */
  // 只记「发生了什么」，不记题目内容、不记答案、不关联邮箱。
  // 事件先攒在内存里，3 秒合并成一批上报；条数多了立刻发，离开页面时兜底发一次。
  const TRACK_Q = [];
  let trackTimer = 0, trackBusy = false;

  /** 当前题库的标识：内置题库用目录 id（f001 / p099），自建题库用 own:<id> */
  function bankTag() {
    const b = curBank();
    if (!b) return null;
    return b.catalogId ? String(b.catalogId) : ('own:' + b.id);
  }

  function track(name, opt) {
    try {
      if (!name) return;
      opt = opt || {};
      const e = { n: name };
      const b = opt.bank !== undefined ? opt.bank : bankTag();
      if (b) e.b = String(b).slice(0, 64);
      if (opt.ok !== undefined && opt.ok !== null) e.ok = !!opt.ok;
      if (opt.ms > 0) e.d = Math.min(3600000, Math.round(opt.ms));
      if (opt.sid) e.sid = String(opt.sid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      if (opt.p) {
        const p = {};
        Object.keys(opt.p).forEach(k => {
          const v = opt.p[k];
          if (v === null || v === undefined) return;
          p[k] = typeof v === 'number' ? Math.round(v) : String(v).slice(0, 40);
        });
        if (Object.keys(p).length) e.p = p;
      }
      TRACK_Q.push(e);
      if (TRACK_Q.length >= 12) flushTrack(); else scheduleFlush();
    } catch (err) {}
  }

  function scheduleFlush() {
    if (trackTimer || trackBusy) return;
    trackTimer = setTimeout(() => { trackTimer = 0; flushTrack(); }, 3000);
  }

  function flushTrack() {
    if (trackTimer) { clearTimeout(trackTimer); trackTimer = 0; }
    if (trackBusy || !TRACK_Q.length) return;
    if (!window.Q || !window.Q.cloud || !window.Q.cloud.track) { TRACK_Q.length = 0; return; }
    const batch = TRACK_Q.splice(0, 40);
    trackBusy = true;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true; trackBusy = false;
      if (TRACK_Q.length) scheduleFlush();
    };
    try {
      const p = window.Q.cloud.track({ vid: visitId(), ua: visitUa(), events: batch });
      if (p && typeof p.then === 'function') p.then(done, done);
      else done();
    } catch (e) {
      // 上报失败就把这批丢掉，不能让失败的事件一直堆着重试
      done();
    }
  }
  /** 练习会话：一次「开始练习」一个 sid，用来算人均答几题、有没有做完 */
  function newSessionId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  /** 开启新会话前，把上一个没收尾的会话标成「中途离开」 */
  function closeSession() {
    if (!S.sid || S.pFinished) { S.sid = null; return; }
    track('practice_end', { bank: S.bankTagAtStart || bankTag(), sid: S.sid, ok: false,
      p: { answered: S.pStat ? S.pStat.done : 0, total: S.pq.length } });
    S.sid = null;
  }

  /* ================= 启动 ================= */
  async function boot() {
    setTheme(localStorage.getItem(LS.theme) || 'light');
    // 支持 #stats / ?tab=stats 直达某个标签
    const wantTab = (new URLSearchParams(location.search).get('tab') || location.hash.replace('#', '')).trim();
    if (TABS.indexOf(wantTab) >= 0) S.tab = wantTab;
    bindGlobal();
    try {
      await C.boot();
    } catch (e) {
      console.warn('cloud boot failed', e);
      toast('云端连接失败，暂时只能使用本机功能', 'bad');
    }
    trackVisit();
    await mergeBanks();
    await loadCatalog();
    await restoreCatalogBanks();
    if (!S.banks.length) {
      $('#view-practice').innerHTML = emptyBanksHtml();
      bindActs($('#view-practice'));
    } else {
      await selectBank(S.bankId || S.banks[0].id);
    }
    S.booted = true;
    render();
  }

  window.addEventListener('DOMContentLoaded', boot);
  Q.app = { S, render, selectBank, toast };
})(window.Q);
