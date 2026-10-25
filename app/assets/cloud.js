/* ================= 云端接入：登录、题库、次数、进度 ================= */
window.Q = window.Q || {};
(function (Q) {
  const cfg = window.Q_CONFIG.cloud;
  const bus = {};
  let cloud = null;
  let session = null;
  let user = null;
  let profile = null;
  let pricing = null;
  let ready = false;

  function on(evt, fn) { (bus[evt] = bus[evt] || []).push(fn); }
  function emit(evt, payload) { (bus[evt] || []).forEach(fn => { try { fn(payload); } catch (e) { console.warn(e); } }); }

  function init() {
    if (!window.WorkBuddyCloud) throw new Error('云端 SDK 未加载，请检查网络');
    cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: cfg.endpoint,
      publishableKey: cfg.publishableKey
    });
    cloud.auth.onAuthStateChange((event, s) => {
      session = s || null;
      if (event === 'SIGNED_OUT') { user = null; profile = null; }
      emit('auth', { event, session });
    });
    return cloud;
  }

  function unwrap(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  async function boot() {
    init();
    try {
      const s = await cloud.auth.getSession();
      session = (s && s.data) ? s.data : null;
      if (session) {
        try {
          const u = await cloud.auth.getUser();
          user = u && u.data ? (u.data.user || u.data) : null;
        } catch (e) { user = session.user || null; }
        await loadProfile();
      }
    } catch (e) {
      session = null;
    }
    await loadPricing();
    ready = true;
    emit('ready', { session, user, profile, pricing });
    return { session, user, profile, pricing };
  }

  async function loadPricing() {
    try {
      const { data, error } = await cloud.database.from('quiz_config').select('key,value');
      if (error) throw error;
      const map = {};
      (data || []).forEach(r => { map[r.key] = r.value; });
      pricing = {
        freeCredits: num(map.free_credits, window.Q_CONFIG.defaults.freeCredits),
        cost: {
          ai_import: 0,
          ai_notes: num(map.cost_ai_notes, window.Q_CONFIG.defaults.cost.ai_notes),
          ai_find: num(map.cost_ai_find, window.Q_CONFIG.defaults.cost.ai_find)
        },
        packs: [
          { id: 'pack_10', credits: num(map.pack_10_credits, 10), price: num(map.pack_10_price, 990) / 100, label: '10 次' },
          { id: 'pack_30', credits: num(map.pack_30_credits, 30), price: num(map.pack_30_price, 2490) / 100, label: '30 次', hot: true }
        ]
      };
    } catch (e) {
      pricing = JSON.parse(JSON.stringify(window.Q_CONFIG.defaults));
    }
    return pricing;
  }
  function num(v, d) { const n = parseInt(v, 10); return isNaN(n) ? d : n; }

  async function loadProfile() {
    if (!session) { profile = null; return null; }
    const startedSession = session;
    try {
      const d = unwrap(await cloud.database.rpc('quiz_ensure_profile'));
      if (session !== startedSession) return null;
      const next = Array.isArray(d) ? d[0] : d;
      if (!next) throw new Error('ACCOUNT_UNAVAILABLE');
      profile = next;
      return profile;
    } catch (e) {
      // Preserve the last known values; a failed read is not a zero balance.
      if (session === startedSession) emit('error', e);
      return null;
    }
  }

  /* ---------------- 认证 ---------------- */
  async function signInPassword(email, password) {
    const r = await cloud.auth.signInWithPassword({ email, password });
    if (r.error) throw r.error;
    await afterLogin();
    return r.data;
  }
  async function signInOtp(email, code) {
    const started = await cloud.auth.signInWithOtp({ email });
    if (started.error) throw started.error;
    const done = await started.data.verify({ token: code });
    if (done.error) throw done.error;
    await afterLogin();
    return done.data;
  }
  async function sendOtp(email) {
    const r = await cloud.auth.sendOtp({ email });
    if (r.error) throw r.error;
    return r.data; // { verificationId, isExistingUser }
  }
  async function verifyOtp({ email, code, verificationId, isExistingUser, password }) {
    const payload = {
      verificationId, token: code, email,
      isExistingUser: !!isExistingUser
    };
    if (password) payload.password = password;
    const r = await cloud.auth.verifyOtp(payload);
    if (r.error) throw r.error;
    await afterLogin();
    return r.data;
  }
  async function verifySignup({ email, code, password, verificationId, isExistingUser }) {
    return verifyOtp({ email, code, password: isExistingUser ? undefined : password, verificationId, isExistingUser });
  }
  async function beginReset(email) {
    const r = await cloud.auth.resetPasswordForEmail(email);
    if (r.error) throw r.error;
    return r.data; // 含 updateUser
  }
  async function signOut() {
    try { await cloud.auth.signOut(); } catch (e) {}
    session = null; user = null; profile = null;
    emit('auth', { event: 'SIGNED_OUT', session: null });
  }
  async function afterLogin() {
    const s = await cloud.auth.getSession();
    session = (s && s.data) ? s.data : null;
    try {
      const u = await cloud.auth.getUser();
      user = u && u.data ? (u.data.user || u.data) : null;
    } catch (e) { user = session ? session.user : null; }
    await loadProfile();
    emit('login', { session, user, profile });
  }

  function currentEmail() {
    if (user && user.email) return user.email;
    if (session && session.user && session.user.email) return session.user.email;
    return '';
  }

  /* ---------------- 题库 ---------------- */
  async function listBanks() {
    if (!session) return [];
    const { data, error } = await cloud.database
      .from('quiz_banks')
      .select('id,title,subject,source_kind,source_name,question_count,data,created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function createBank({ title, subject, source_kind, source_name, data, question_count }) {
    const { data: rows, error } = await cloud.database.from('quiz_banks').insert({
      title, subject: subject || null, source_kind: source_kind || 'manual',
      source_name: source_name || null, data, question_count: question_count || 0
    }).select();
    if (error) throw error;
    return rows && rows[0];
  }
  async function renameBank(id, title) {
    const { data, error } = await cloud.database.from('quiz_banks').update({ title, updated_at: new Date().toISOString() }).eq('id', id).select();
    if (error) throw error;
    return data && data.length > 0;
  }
  async function updateBankData(id, data, question_count) {
    const { data: rows, error } = await cloud.database.from('quiz_banks')
      .update({ data, question_count, updated_at: new Date().toISOString() }).eq('id', id).select();
    if (error) throw error;
    return rows && rows.length > 0;
  }
  async function deleteBank(id) {
    const { data, error } = await cloud.database.from('quiz_banks').delete().eq('id', id).select();
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  /* ---------------- 知识点 ---------------- */
  async function listNotes(bankId) {
    if (!session) return [];
    const { data, error } = await cloud.database.from('quiz_notes')
      .select('id,bank_id,title,content_html,created_at')
      .eq('bank_id', bankId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function createNote({ bank_id, title, content_html }) {
    const { data, error } = await cloud.database.from('quiz_notes')
      .insert({ bank_id, title, content_html }).select();
    if (error) throw error;
    return data && data[0];
  }
  async function deleteNote(id) {
    const { data, error } = await cloud.database.from('quiz_notes').delete().eq('id', id).select();
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  /* ---------------- 练习进度 ---------------- */
  async function getProgress(bankId) {
    if (!session) return null;
    const { data, error } = await cloud.database.from('quiz_progress')
      .select('data').eq('bank_id', bankId).maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  }
  async function saveProgress(bankId, progress) {
    if (!session) return false;
    const payload = { data: progress, updated_at: new Date().toISOString() };
    const up = await cloud.database.from('quiz_progress').update(payload).eq('bank_id', bankId).select();
    if (up.error) throw up.error;
    if (up.data && up.data.length) return true;
    const ins = await cloud.database.from('quiz_progress').insert({ bank_id: bankId, data: progress });
    if (ins.error) {
      if (ins.error.code === '23505') {
        const retry = await cloud.database.from('quiz_progress').update(payload).eq('bank_id', bankId).select();
        if (retry.error) throw retry.error;
        if (!retry.data || !retry.data.length) throw new Error('进度冲突，稍后重试');
        return true;
      }
      throw ins.error;
    }
    return true;
  }

  async function reportQuestion(payload) {
    if (!session) throw new Error('请先登录');
    const { error } = await cloud.database.from('quiz_question_reports').insert(payload);
    if (error) throw error;
    return true;
  }

  /* ---------------- 题库市场 ---------------- */
  async function listCatalog() {
    const { data, error } = await cloud.database.from('quiz_catalog')
      .select('id,title,org,kind,price_cents,question_count,chapter_count,sort_order')
      .order('kind', { ascending: true })
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function fetchCatalogBank(id) {
    const { data, error } = await cloud.database.from('quiz_catalog_banks')
      .select('catalog_id,kind,chapters').eq('catalog_id', id).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  async function myUnlocks() {
    if (!session) return [];
    const { data, error } = await cloud.database.from('quiz_unlocks').select('catalog_id,paid_cents,created_at');
    if (error) throw error;
    return data || [];
  }
  async function unlock(catalogId) {
    if (!session) throw new Error('AUTH_REQUIRED');
    const d = unwrap(await cloud.database.rpc('quiz_unlock', { p_catalog: catalogId }));
    const r = Array.isArray(d) ? d[0] : d;
    if (r && r.balance != null && profile) profile.balance_cents = r.balance;
    if (r && r.ok) emit('credits', profile);
    return r;
  }
  // One server-side redemption path for both balance codes and AI-credit codes.
  // Never infer money from a field named "balance": old APIs use that name for AI credits.
  const pendingRedemptions = new Map();
  function normalizeCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '').replace(/[‐‑‒–—−]/g, '-');
  }
  function validQuota(value) {
    return value !== null && value !== undefined && value !== ''
      && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  }
  async function recharge(code) {
    if (!session) throw new Error('AUTH_REQUIRED');
    code = normalizeCode(code);
    if (!code || code.length > 128) throw new Error('请输入有效兑换码');
    const startedSession = session;
    const key = code;
    const previous = pendingRedemptions.get(key);
    if (previous && previous.session === startedSession) return previous.promise;
    const promise = (async () => {
      const d = unwrap(await cloud.database.rpc('quiz_recharge', { p_code: code }));
      const r = Array.isArray(d) ? d[0] : d;
      if (!r || !r.ok) return r;
      // The server has already committed. A refresh failure must never invite another redemption.
      if (session !== startedSession) return Object.assign({}, r, { refresh_pending: true });
      const cached = profile ? Object.assign({}, profile) : null;
      if (cached && validQuota(r.balance_cents)) cached.balance_cents = Number(r.balance_cents);
      if (cached && validQuota(r.credits_balance)) cached.credits = Number(r.credits_balance);
      // Read the authoritative account after the mutation, including RPCs with partial responses.
      const refreshed = await loadProfile();
      if (session !== startedSession) return Object.assign({}, r, { refresh_pending: true });
      const confirmed = refreshed && validQuota(refreshed.balance_cents) && validQuota(refreshed.credits);
      if (!confirmed) profile = cached;
      emit('credits', profile);
      return Object.assign({}, r, { refresh_pending: !confirmed });
    })();
    pendingRedemptions.set(key, { session: startedSession, promise });
    try { return await promise; }
    finally {
      const current = pendingRedemptions.get(key);
      if (current && current.promise === promise) pendingRedemptions.delete(key);
    }
  }
  async function buyCredits(n) {
    if (!session) throw new Error('AUTH_REQUIRED');
    const d = unwrap(await cloud.database.rpc('quiz_buy_credits', { p_n: n || 1 }));
    const r = Array.isArray(d) ? d[0] : d;
    if (r && r.ok && profile) {
      profile.balance_cents = r.balance;
      profile.credits = r.credits;
    }
    if (r && r.ok) emit('credits', profile);
    return r;
  }

  /* ---------------- 次数 ---------------- */
  async function spend(action, note) {
    if (!session) throw new Error('AUTH_REQUIRED');
    const d = unwrap(await cloud.database.rpc('quiz_spend', { p_action: action, p_note: note || null }));
    const r = Array.isArray(d) ? d[0] : d;
    if (r && r.ok) {
      if (profile) profile.credits = r.balance;
      emit('credits', profile);
    }
    return r;
  }
  async function refund(usageId) {
    if (!session || !usageId) return null;
    const d = unwrap(await cloud.database.rpc('quiz_refund', { p_usage_id: usageId }));
    const r = Array.isArray(d) ? d[0] : d;
    if (r && r.ok) {
      if (profile) profile.credits = r.balance;
      emit('credits', profile);
    }
    return r;
  }
  // Compatibility alias: old callers must use the same atomic server-side redemption.
  async function redeem(code) { return recharge(code); }
  async function usageList(limit) {
    if (!session) return [];
    const { data, error } = await cloud.database.from('quiz_usage')
      .select('id,action,cost,note,refunded,created_at')
      .order('created_at', { ascending: false }).limit(limit || 30);
    if (error) throw error;
    return data || [];
  }
  async function orderList(limit) {
    if (!session) return [];
    const { data, error } = await cloud.database.from('quiz_orders')
      .select('id,kind,code,credits,amount_cents,created_at')
      .order('created_at', { ascending: false }).limit(limit || 20);
    if (error) throw error;
    return data || [];
  }

  /* ---------------- 访问埋点 ---------------- */
  // 匿名也能上报；一天一个设备一行，同一天再打开只累加 pv。
  // 失败一律静默——统计挂掉绝不能影响页面加载。
  async function pingVisit(payload) {
    if (!cloud) return null;
    try {
      const d = unwrap(await cloud.database.rpc('quiz_visit_ping', {
        p_vid: (payload && payload.vid) || null,
        p_ua: (payload && payload.ua) || null,
        p_src: (payload && payload.src) || null
      }));
      return Array.isArray(d) ? d[0] : d;
    } catch (e) { return null; }
  }
  /* ---------------- 行为埋点 ---------------- */
  // 批量上报：一次调用写多行，服务端按白名单过滤事件名。
  // 和 pingVisit 一样全静默——埋点挂掉绝不能让练习流程受影响。
  async function track(payload) {
    if (!cloud) return null;
    const events = (payload && payload.events) || [];
    if (!events.length) return null;
    try {
      const d = unwrap(await cloud.database.rpc('quiz_track', {
        p_vid: (payload && payload.vid) || null,
        p_ua: (payload && payload.ua) || null,
        p_events: events
      }));
      return Array.isArray(d) ? d[0] : d;
    } catch (e) { return null; }
  }
  Q.cloud = {
    on, init, boot,
    get client() { return cloud; },
    get session() { return session; },
    get user() { return user; },
    get profile() { return profile; },
    get pricing() { return pricing; },
    get ready() { return ready; },
    reloadPricing: loadPricing,
    reloadProfile: loadProfile,
    currentEmail,
    signInPassword, signInOtp, sendOtp, verifyOtp, verifySignup, beginReset, signOut,
    listBanks, createBank, renameBank, updateBankData, deleteBank,
    listNotes, createNote, deleteNote,
    listCatalog, fetchCatalogBank, myUnlocks, unlock, recharge, buyCredits,
    getProgress, saveProgress, reportQuestion,
    spend, refund, redeem, usageList, orderList,
    pingVisit, track
  };
})(window.Q);
