/* ================= AI 服务：解析题库 / 生成知识点 / 代找题库 ================= */
window.Q = window.Q || {};
(function (Q) {
  const AI = {};
  const cfg = window.Q_CONFIG.ai;
  let modelId = null;
  let modelReady = false;

  function logErr(e) { console.warn('[AI]', e); }

  function friendly(e) {
    const code = (e && e.error && e.error.code) || (e && e.code) || '';
    if (String(code).indexOf('quota_') === 0) return 'AI 额度已用尽，请稍后再试或联系客服';
    if (String(code).indexOf('auth_') === 0) return 'AI 服务配置异常，请稍后再试';
    if (String(code).indexOf('request_') === 0) return '请求参数不被模型接受，请换一种说法或减少内容';
    if (String(code).indexOf('gateway_') === 0 || String(code).indexOf('model_') === 0) return '模型服务暂时不可用，请稍后重试';
    return (e && e.message) || 'AI 调用失败，请重试';
  }

  /**
   * 选模型：先按 cfg.preferModels 顺序命中（默认 DeepSeek 系列，成本最低），
   * 都没有才退回上下文最大的可用模型。挑模型直接决定单次调用成本，
   * 不要用「上下文最大」当唯一标准。
   */
  async function pickModel() {
    if (modelReady && modelId) return modelId;
    const client = Q.cloud.client;
    const models = await client.llm.models.list();
    const list = (models || []).filter(m => m.disabled !== true && m.enabled !== false);
    if (!list.length) throw new Error('当前没有可用的 AI 模型');

    const prefer = (cfg.preferModels || []).slice();
    for (const want of prefer) {
      const hit = list.find(m => m.id === want);
      if (hit) { modelId = hit.id; modelReady = true; return modelId; }
    }
    const byCtx = list.slice().sort((a, b) => (b.maxInputTokens || 0) - (a.maxInputTokens || 0));
    modelId = byCtx[0].id;
    modelReady = true;
    return modelId;
  }

  /* 统一流式调用：返回完整文本，边收边回调 */
  AI.chat = async function (messages, opts) {
    opts = opts || {};
    if (cfg.provider === 'proxy' && cfg.proxy.url) return chatViaProxy(messages, opts);
    return chatViaCloud(messages, opts);
  };

  async function chatViaCloud(messages, opts) {
    const client = Q.cloud.client;
    if (!client) throw new Error('云端未初始化');
    const id = await pickModel();

    // 推理型模型不一定接受 response_format，被拒时去掉它重试一次
    const wantJson = !!opts.json;
    try {
      return await runStream(id, messages, opts, wantJson);
    } catch (e) {
      const code = (e && e.error && e.error.code) || (e && e.code) || '';
      if (wantJson && String(code).indexOf('request_') === 0) {
        console.warn('[AI] response_format 不被接受，改为纯提示词约束 JSON');
        return await runStream(id, messages, opts, false);
      }
      throw e;
    }
  }

  async function runStream(id, messages, opts, withJson) {
    const client = Q.cloud.client;
    const params = {
      model: id,
      messages,
      stream: true,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : cfg.temperature,
      signal: opts.signal
    };
    if (withJson) params.response_format = { type: 'json_object' };
    let out = '';
    try {
      for await (const chunk of client.llm.chat.completions.create(params)) {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta && delta.content) {
          out += delta.content;
          if (opts.onDelta) opts.onDelta(delta.content, out);
        }
      }
    } catch (e) {
      logErr(e);
      throw new Error(friendly(e));
    }
    return out;
  }

  async function chatViaProxy(messages, opts) {
    const res = await fetch(cfg.proxy.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.proxy.model,
        messages,
        stream: true,
        temperature: typeof opts.temperature === 'number' ? opts.temperature : cfg.temperature,
        response_format: opts.json ? { type: 'json_object' } : undefined
      }),
      signal: opts.signal
    });
    if (!res.ok) throw new Error('代理服务返回 ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', out = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (d) { out += d; if (opts.onDelta) opts.onDelta(d, out); }
        } catch (e) {}
      }
    }
    return out;
  }

  function extractJSON(text) {
    if (!text) throw new Error('模型没有返回内容');
    let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    try {
      return JSON.parse(t);
    } catch (e) {
      // 常见修复：去掉尾逗号
      try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch (e2) {}
      throw new Error('AI 返回的内容不是合法 JSON，请重试一次');
    }
  }

  const SCHEMA_HINT = '{"chapters":[{"title":"章节标题","sec":"1.1","name":"章节名","questions":[{"no":1,"type":"单选题","stem":"题干","options":[{"k":"A","v":"选项"}],"answer":"C","note":"解析"}]}]}';

  function normType(t) {
    if (!t) return '';
    if (/多/.test(t)) return '多选题';
    if (/判断/.test(t)) return '判断题';
    if (/单选|单项/.test(t)) return '单选题';
    return '';
  }

  function normalizeChapters(obj) {
    let chs = obj && obj.chapters;
    if (!chs && obj && Array.isArray(obj.questions)) {
      chs = [{ title: '题目', sec: '1', name: '题目', questions: obj.questions }];
    }
    if (!chs && Array.isArray(obj)) chs = obj;
    chs = chs || [];
    return chs.map((ch, ci) => {
      const qs = (ch.questions || ch.qs || []).map((q, qi) => {
        let type = normType(q.type);
        let options = (q.options || []).map((o, oi) => ({
          k: (o.k || String.fromCharCode(65 + oi)).toString().toUpperCase().slice(0, 1),
          v: String(o.v || o.text || '').trim()
        })).filter(o => o.v);
        let answer = String(q.answer == null ? '' : q.answer).trim();
        answer = answer.replace(/[^A-Ha-h√×✓✗对错正确误是否]/g, '');
        if (/^(√|✓|对|正确|是|T|TRUE)$/i.test(answer)) answer = '√';
        else if (/^(×|✗|X|错|错误|否|F|FALSE)$/i.test(answer)) answer = 'X';
        else answer = answer.toUpperCase().split('').filter(c => /[A-H]/.test(c)).filter((c, i, a) => a.indexOf(c) === i).sort().join('');
        if (!type) type = options.length ? (answer.length > 1 ? '多选题' : '单选题') : '判断题';
        if (type === '判断题') options = [];
        return {
          no: qi + 1,
          type,
          stem: String(q.stem || q.question || '').replace(/^\d+\s*[.、．]\s*/, '').trim(),
          options,
          answer,
          note: String(q.note || q.explanation || '').trim()
        };
      }).filter(q => q.stem && q.stem.length > 1);
      return {
        title: ch.title || ('第 ' + (ci + 1) + ' 章'),
        sec: String(ch.sec || (ci + 1)),
        name: ch.name || ch.title || ('第 ' + (ci + 1) + ' 章'),
        qs
      };
    }).filter(ch => ch.qs.length);
  }

  function mergeChapters(all) {
    const out = [];
    const index = {};
    all.forEach(chs => chs.forEach(ch => {
      const key = ch.sec + '||' + ch.name;
      if (index[key]) {
        const t = index[key];
        ch.qs.forEach(q => { q.no = t.qs.length + 1; t.qs.push(q); });
      } else {
        index[key] = ch;
        out.push(ch);
      }
    }));
    out.forEach(ch => ch.qs.forEach((q, i) => { q.no = i + 1; }));
    return out;
  }

  /* ---------------- 1. AI 结构化题库 ---------------- */
  AI.parseBank = async function (text, opts) {
    opts = opts || {};
    const chunks = Q.parse.splitForAI(text, cfg.chunkChars);
    const all = [];
    const warnings = [];
    for (let i = 0; i < chunks.length; i++) {
      if (opts.signal && opts.signal.aborted) throw new Error('已取消');
      if (opts.onProgress) opts.onProgress(i, chunks.length, '正在解析第 ' + (i + 1) + ' / ' + chunks.length + ' 段');
      const fallback = Q.parse.fromText(chunks[i], '').chapters;
      const fallbackCount = fallback.reduce((n, ch) => n + ch.qs.length, 0);
      try {
      const raw = await AI.chat([
        {
          role: 'system',
          content: '你是题库结构化引擎。你只输出 JSON，不输出解释、不输出 markdown 代码块。你绝不编造原文没有的答案。'
        },
        {
          role: 'user',
          content: '把下面的考试题文本完整转成 JSON，不要只选取示例或前几题。\n\n结构：' + SCHEMA_HINT + '\n\n规则：\n1. 题干去掉题号和选项，不含「答案」「解析」字样；\n2. 选项 keys 按原文保留 A 到 H，判断题 options 为空数组；\n3. 单选 answer 如 "C"，多选按字母升序如 "ACD"，判断用 "√" 或 "X"；\n4. 原文没有答案就填空字符串，不要猜；\n5. 按原文的章节/小节分组，没有章节就放一个「题目」章节；\n6. 不遗漏任何一道题，只输出 JSON。\n\n文本：\n' + chunks[i]
        }
      ], { json: true, signal: opts.signal, onDelta: opts.onDelta, temperature: 0.2 });
      const parsed = normalizeChapters(extractJSON(raw));
      const count = parsed.reduce((n, ch) => n + ch.qs.length, 0);
      if (count < fallbackCount) {
        all.push(fallback);
        warnings.push('第 ' + (i + 1) + ' 段 AI 返回 ' + count + ' 题，少于规则识别的 ' + fallbackCount + ' 题；已保留规则识别结果');
      } else all.push(parsed);
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw e;
        if (!fallbackCount) throw e;
        all.push(fallback);
        warnings.push('第 ' + (i + 1) + ' 段 AI 未完成，已保留规则识别的 ' + fallbackCount + ' 题');
      }
    }
    const chapters = mergeChapters(all);
    const total = chapters.reduce((a, ch) => a + ch.qs.length, 0);
    if (!total) throw new Error('AI 没有从这段内容里识别出题目，换一份文本或手动整理后重试');
    return { chapters, total, warnings };
  };

  /* ---------------- 2. AI 代找题库 ---------------- */
  AI.findBank = async function (opts) {
    opts = opts || {};
    const subject = (opts.subject || '').trim();
    if (!subject) throw new Error('请先填写课程或考试名称');
    const count = Math.max(10, Math.min(40, parseInt(opts.count, 10) || 20));
    const typeText = opts.types && opts.types.length ? opts.types.join('、') : '单选题、多选题、判断题';
    if (opts.onProgress) opts.onProgress(0, 1, '正在依据公开课程知识组题');

    const raw = await AI.chat([
      {
        role: 'system',
        content: '你是严谨的题库编制助手。你依据公开的课程知识点出题，答案必须确定；没有把握的题宁可不写。只输出 JSON。'
      },
      {
        role: 'user',
        content: '为「' + subject + '」编制一套练习题，共 ' + count + ' 题，题型为：' + typeText + '。\n'
          + (opts.scope ? '范围/教材：' + opts.scope + '\n' : '')
          + (opts.level ? '难度：' + opts.level + '\n' : '')
          + '\n结构：' + SCHEMA_HINT + '\n\n规则：\n'
          + '1. 按 4-8 个章节/专题分组，sec 用 1、2、3…，name 是章节名；\n'
          + '2. 每题 4 个选项，干扰项要合理，不要出现「以上都是」这种凑数选项；\n'
          + '3. 单选题 answer 为单个字母，多选题 2-4 个字母，判断题用 "√"/"X"；\n'
          + '4. note 写 30 字以内的考点提示；\n'
          + '5. 不要重复题，不要编造不存在的教材原文；\n'
          + '6. 只输出 JSON。\n'
      }
    ], { json: true, signal: opts.signal, onDelta: opts.onDelta, temperature: 0.5 });

    const chapters = normalizeChapters(extractJSON(raw));
    const total = chapters.reduce((a, ch) => a + ch.qs.length, 0);
    if (!total) throw new Error('AI 没有返回可用题目，换个课程名或稍后重试');
    return { chapters, total };
  };

  /* ---------------- 3. AI 生成知识点 ---------------- */
  AI.generateNotes = async function (opts) {
    opts = opts || {};
    const chapters = opts.chapters || [];
    if (!chapters.length) throw new Error('这个题库还没有题目，先生成或导入题目');
    const sample = [];
    chapters.forEach(ch => {
      (ch.qs || []).slice(0, 3).forEach(q => {
        sample.push('[' + (ch.name || ch.title) + '] ' + q.stem.slice(0, 70));
      });
    });
    if (opts.onProgress) opts.onProgress(0, 1, '正在梳理章节脉络');
    const prompt = '课程：《' + (opts.title || '未命名') + '》\n\n'
      + '章节结构与样题：\n' + sample.slice(0, 80).join('\n') + '\n\n'
      + '请写一份用于期末复习的知识点手册，要求：\n'
      + '1. 用 HTML 片段输出（h2/h3/ul/li/table/strong/blockquote/p），不要 <html>/<body>，不要 markdown 代码块；\n'
      + '2. 按章节组织，每章先一句话点出「本章主线」，再列 3-8 条核心考点；\n'
      + '3. 高频考点用 <strong>★高频</strong> 标记，容易混淆的用 <blockquote>易错辨析：…</blockquote>；\n'
      + '4. 只依据上面给出的章节和样题归纳，不要编造教材里没有的结论；\n'
      + '5. 语言简洁，能直接背，不要空话。\n';
    const html = await AI.chat([
      { role: 'system', content: '你是课程复习资料编辑，擅长把题库归纳成可背诵的知识点手册。只输出 HTML 片段。' },
      { role: 'user', content: prompt }
    ], { signal: opts.signal, onDelta: opts.onDelta, temperature: 0.4 });
    return sanitizeHtml(stripFence(html));
  };

  function stripFence(s) {
    return String(s || '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  /* ---------------- HTML 白名单净化 ---------------- */
  const ALLOWED = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I',
    'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'HR', 'BR', 'CODE', 'PRE', 'SPAN', 'DIV', 'MARK', 'SMALL']);

  function sanitizeHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walk = (node) => {
      const children = Array.prototype.slice.call(node.childNodes);
      children.forEach(child => {
        if (child.nodeType === 1) {
          if (!ALLOWED.has(child.tagName)) {
            const text = document.createTextNode(child.textContent || '');
            node.replaceChild(text, child);
            return;
          }
          Array.prototype.slice.call(child.attributes).forEach(attr => {
            const n = attr.name.toLowerCase();
            const keep = (child.tagName === 'TD' || child.tagName === 'TH') && (n === 'colspan' || n === 'rowspan');
            if (!keep) child.removeAttribute(attr.name);
          });
          walk(child);
        } else if (child.nodeType === 8) {
          node.removeChild(child);
        }
      });
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }

  AI.sanitizeHtml = sanitizeHtml;
  AI.extractJSON = extractJSON;
  AI.available = () => !!(Q.cloud.client || (cfg.provider === 'proxy' && cfg.proxy.url));

  Q.ai = AI;
})(window.Q);
