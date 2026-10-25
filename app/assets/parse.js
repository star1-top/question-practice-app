/* ================= 题库解析：PDF / DOCX / MD / TXT / 粘贴 ================= */
window.Q = window.Q || {};
(function (Q) {
  const P = {};
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'assets/vendor/pdf.worker.min.js';
  }

  const MAX_FILE = 25 * 1024 * 1024;

  /* ---------------- 读取文件 ---------------- */
  P.readFile = async function (file, onProgress) {
    if (!file) throw new Error('没有选择文件');
    if (file.size > MAX_FILE) throw new Error('文件超过 25MB，请拆分后再导入');
    const name = file.name || '未命名';
    const ext = (name.split('.').pop() || '').toLowerCase();

    if (ext === 'pdf') {
      if (!window.pdfjsLib) throw new Error('PDF 解析库未加载，请检查网络后重试');
      const buf = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
      const pages = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        const lines = [];
        let lastY = null, cur = '';
        (tc.items || []).forEach(it => {
          if (!it.str) return;
          const y = it.transform ? it.transform[5] : 0;
          if (lastY === null || Math.abs(y - lastY) < 3.2) {
            cur += it.str;
          } else {
            if (cur.trim()) lines.push(cur);
            cur = it.str;
          }
          lastY = y;
        });
        if (cur.trim()) lines.push(cur);
        pages.push(lines.join('\n'));
        if (onProgress) onProgress(p, pdf.numPages);
      }
      const text = pages.join('\n\n');
      if (text.replace(/\s/g, '').length < 30) {
        throw new Error('这个 PDF 没有可提取的文字（多半是扫描件）。请先 OCR，或直接把题目复制粘贴进来。');
      }
      return { text, name, kind: 'pdf' };
    }

    if (ext === 'docx') {
      if (!window.mammoth) throw new Error('DOCX 解析库未加载，请检查网络后重试');
      const buf = await file.arrayBuffer();
      const r = await window.mammoth.extractRawText({ arrayBuffer: buf });
      return { text: r.value || '', name, kind: 'docx' };
    }

    if (ext === 'doc') {
      throw new Error('旧版 .doc 格式读不了，请在 Word / WPS 里「另存为 .docx」后再导入');
    }

    if (ext === 'txt' || ext === 'md' || ext === 'markdown' || ext === 'csv' || !ext) {
      const buf = await file.arrayBuffer();
      const text = decodeText(buf);
      return { text, name, kind: ext === 'md' || ext === 'markdown' ? 'md' : 'txt' };
    }

    throw new Error('暂不支持 .' + ext + ' 格式，支持 PDF / DOCX / MD / TXT');
  };

  function decodeText(buf) {
    let t = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const bad = (t.match(/\ufffd/g) || []).length;
    if (bad > 0 && bad / Math.max(t.length, 1) > 0.005) {
      try {
        const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf);
        if ((gbk.match(/\ufffd/g) || []).length < bad) return gbk;
      } catch (e) {}
    }
    return t.replace(/^\ufeff/, '');
  }

  /* ---------------- 文本清洗 ---------------- */
  function clean(text) {
    return (text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0|\u3000/g, ' ')
      // 答案文档里常见的垃圾行：占位答案、分隔线、Word 表单控件残留
      .replace(/正确答案\s*[：:]\s*[（(]?\s*原文档未提供答案\s*[)）]?/g, '')
      .replace(/^[\s]*窗体(顶端|底端)[\s]*$/gm, '')
      .replace(/^[\s\-=─━_]{6,}$/gm, '')
      .replace(/^更多(资料|题库|课程).*$/gm, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n');
  }

  const RE = {
    heading: /^(#{1,4})\s+(.+)$/,
    chapter: /^第\s*[一二三四五六七八九十百零\d]+\s*[章讲课节]\s*[、.．:：]?\s*(.*)$/,
    section: /^(\d{1,2})[.．](\d{1,2})\s*[、.．:：]?\s*(.*)$/,
    secOnly: /^(\d{1,2})[.．](\d{1,2})$/,
    cnSection: /^[一二三四五六七八九十]+\s*[、.．]\s*(.*)$/,
    qStart: /^(?:第\s*)?(\d{1,5})\s*[.、．)）]\s*(.*)$/,
    qStartParen: /^[（(]\s*(\d{1,5})\s*[)）]\s*(.*)$/,
    // 题号紧跟题型标签：3【多选题】题干 / 1、【单选题】题干
    qTyped: /^(\d{1,5})\s*[.、．)）]?\s*[【\[（(]\s*(单选题|多选题|判断题|单项选择题|多项选择题|不定项选择题|单选|多选|判断)\s*[】\])）]\s*(.*)$/,
    // 选项：A、内容 / A.内容 / A 内容（空格分隔，常见于整段复制的答案文档）
    option: /^([A-Ha-hＡ-Ｈ])(?:\s*[.、．)）:：]\s*|\s+)(.*)$/,
    answer: /^[【\[]?\s*(参考答案|正确答案|标准答案|我的答案|答案|Answer|ANS)\s*[】\]]?\s*[:：]?\s*(.*)$/i,
    analysis: /^[【\[]?\s*(答案解析|解析|考点|备注|说明)\s*[】\]]?\s*[:：]?\s*(.*)$/,
    // 答案挤在选项行尾：D 64 答案：C
    inlineAnswer: /[答答]\s*案\s*[：:]\s*([A-H√×✓✗对错]{1,4})\s*$/,
    pageNo: /^[\s\-—–_·]*\d{1,3}[\s\-—–_·]*$/,
    // "第1 题" 这类分隔行：本身不含题干，下一行才是题干
    qMarker: /^第\s*\d{1,3}\s*题\s*[:：]?\s*$/,
    // "1 单元测验" / "2 第一章测试"
    unitTitle: /^(\d{1,2})\s*(单元测验|单元测试|章节测试|章节测验|测试|测验)\s*$/,
    typeTag: /[【\[(（]\s*(单选题|多选题|判断题|单项选择题|多项选择题|不定项选择题|单选|多选|判断)\s*[】\])）]/,
    // 题干里直接带答案：（ABC）
    stemAnswer: /[（(]\s*([A-H]{1,4})\s*[)）]/
  };

  function normType(t) {
    if (!t) return '';
    if (/多/.test(t)) return '多选题';
    if (/判断/.test(t)) return '判断题';
    return '单选题';
  }


  function isChapterLine(line) {
    return RE.heading.test(line) || RE.chapter.test(line) || RE.section.test(line);
  }

  /* ---------------- 规则解析 ---------------- */
  const TYPE_HEAD = /[【\[（(]\s*(单选题|多选题|判断题|单项选择题|多项选择题|不定项选择题|单选|多选|判断)\s*[】\])）]/;

  /* 题号单独一行、题型在下一行（Word 复制常见）→ 合成一行 */
  function mergeLooseLines(lines) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const cur = lines[i].trim();
      const nxt = i + 1 < lines.length ? lines[i + 1].trim() : '';
      if (/^\d{1,5}$/.test(cur) && TYPE_HEAD.test(nxt)) {
        out.push(cur + nxt);
        i++;
        continue;
      }
      out.push(lines[i]);
    }
    return out;
  }

  /* 中文之间的空格是 PDF 换行造成的，删掉更可读 */
  function tidyCn(s) {
    let t = String(s || '');
    let prev;
    do {
      prev = t;
      t = t.replace(/([\u4e00-\u9fa5，。、；：？！“”‘’（）《》…—])\s+([\u4e00-\u9fa5，。、；：？！“”‘’（）《》…—])/g, '$1$2');
    } while (t !== prev);
    return t;
  }

  P.fromText = function (rawText, filename) {
    const text = clean(rawText);
    const lines = mergeLooseLines(text.split('\n'));
    const chapters = [];
    const warnings = [];
    let curChapter = null;
    let curQ = null;
    let lastOption = null;
    let pendingAns = null;
    let questionSerial = 0;
    let missingAnswer = 0;
    let autoSec = 0;

    function pushChapter(title, sec, name) {
      autoSec += 1;
      curChapter = {
        title: title || ('第 ' + autoSec + ' 部分'),
        sec: sec || String(autoSec),
        name: name || title || ('第 ' + autoSec + ' 部分'),
        qs: []
      };
      chapters.push(curChapter);
      curQ = null; lastOption = null;
    }
    function ensureChapter() {
      if (!curChapter) pushChapter('全部题目', '1', '全部题目');
      return curChapter;
    }
    function pushQ(q) {
      const ch = ensureChapter();
      q.no = ch.qs.length + 1;
      ch.qs.push(q);
    }

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;
      if (RE.pageNo.test(line) && line.length < 8) continue;

      // 「我的答案：」与答案值分行的情形：这一行才是答案
      if (pendingAns) {
        const q = pendingAns;
        pendingAns = null;
        if (/^[A-H√×✓✗对错正误]{1,6}$/.test(line)) { applyAnswer(q, line); continue; }
      }

      // 章节 / 小节
      let m;
      if ((m = line.match(RE.heading))) {
        pushChapter(m[2].replace(/[*_`]/g, '').trim(), '', m[2].trim());
        continue;
      }
      if ((m = line.match(RE.secOnly))) {
        // 单独一行的 1.1（没有小节名），当章节占位
        pushChapter(line, m[1] + '.' + m[2], line);
        continue;
      }
      if ((m = line.match(RE.unitTitle))) {
        // "1 单元测验" 这类标题：只有跟当前章节不同才另起章节
        if (!curChapter || curChapter.name.indexOf(line) !== 0) {
          const prevName = chapters.length ? chapters[chapters.length - 1].name : '';
          if (!prevName || prevName.indexOf(m[2]) < 0) pushChapter(line, String(m[1]), line);
        }
        continue;
      }
      if ((m = line.match(RE.section)) && m[3] && m[3].length < 60 && !/[（(]\s*[)）]\s*$/.test(m[3])) {
        const sec = m[1] + '.' + m[2];
        pushChapter(m[3].trim(), sec, m[3].trim());
        continue;
      }
      if ((m = line.match(RE.chapter))) {
        pushChapter(line.replace(/[、.．:：]\s*$/, ''), '', (m[1] || line).trim());
        continue;
      }

      // 解析行（必须放在答案行之前，"答案解析" 不能被当成答案）
      if ((m = line.match(RE.analysis))) {
        if (curQ) curQ.note = (curQ.note ? curQ.note + ' ' : '') + (m[2] || '').trim();
        continue;
      }
      // 答案行
      if ((m = line.match(RE.answer))) {
        if (curQ) {
          const ansRaw = (m[2] || '').trim();
          if (ansRaw) applyAnswer(curQ, ansRaw);
          else pendingAns = curQ;   // 值在下一行
        }
        continue;
      }

      // 选项
      if ((m = line.match(RE.option)) && curQ) {
        const k = m[1].toUpperCase().replace(/[Ａ-Ｈ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
        let v = (m[2] || '').trim();
        // 答案挤在选项行尾：D 64 答案：C
        const im = v.match(RE.inlineAnswer);
        if (im) {
          v = v.slice(0, im.index).trim();
          applyAnswer(curQ, im[1]);
        }
        // 题干里以 A. 开头的短行，只有在已有题干后才当选项
        if (curQ.stem && v) {
          // PDF 常见：一行塞了多个选项 A.1950 B.1980 C.1995
          const pieces = expandInlineOptions(k, v);
          if (pieces.length > 1) {
            pieces.forEach(p => curQ.options.push(p));
            lastOption = curQ.options[curQ.options.length - 1];
          } else {
            lastOption = { k, v };
            curQ.options.push(lastOption);
          }
          continue;
        }
      }

      // "第1 题" 分隔行：先开一条空题，题干由后面的行填进来
      if (RE.qMarker.test(line)) {
        ensureChapter();
        questionSerial++;
        curQ = { no: questionSerial, type: '', stem: '', options: [], answer: '', ans_raw: '', note: '', doubt: '' };
        pushQ(curQ);
        curQ.no = curChapter.qs.length;
        lastOption = null;
        continue;
      }

      // 新题（题号紧跟题型标签，优先于普通题号）
      if ((m = line.match(RE.qTyped))) {
        const stem = (m[3] || '').trim();
        if (stem.length >= 2) {
          ensureChapter();   // 先保证章节存在，否则 pushChapter 会清空 curQ
          questionSerial++;
          curQ = { no: questionSerial, type: normType(m[2]), stem, options: [], answer: '', ans_raw: '', note: '', doubt: '' };
          pushQ(curQ);
          curQ.no = curChapter.qs.length;
          lastOption = null;
          continue;
        }
      }

      // 新题
      let qm = line.match(RE.qStartParen) || line.match(RE.qStart);
      if (qm && !/^[A-Ha-hＡ-Ｈ]\s*[.、．)）]/.test(line)) {
        const stem = (qm[2] || '').trim();
        // 形如 "1. 2. 3." 的目录行跳过
        if (stem.length < 2) { continue; }
        // 明显是小节行（数字.数字）时不当作题目
        if (/^\d{1,2}[.．]\d{1,2}/.test(line)) continue;
        ensureChapter();   // 同上：章节可能还不存在
        questionSerial++;
        curQ = { no: questionSerial, type: '', stem, options: [], answer: '', ans_raw: '', note: '', doubt: '' };
        pushQ(curQ);
        curQ.no = curChapter.qs.length;
        lastOption = null;
        continue;
      }

      // 续行
      if (curQ) {
        if (lastOption && curQ.options.length) {
          // 选项换行续写
          lastOption.v += (lastOption.v ? ' ' : '') + line;
        } else {
          curQ.stem += (curQ.stem ? '\n' : '') + line;
        }
      }
    }

    // 收尾：题型判定、清理
    chapters.forEach(ch => {
      ch.qs.forEach(q => {
        q.stem = tidyCn((q.stem || '').replace(/\s+/g, ' ').trim());
        q.options.forEach(o => { o.v = tidyCn(o.v.replace(/\s+/g, ' ').trim()); });
        q.options = q.options.filter(o => o.v);
        if (RE.typeTag.test(q.stem)) {
          const tag = q.stem.match(RE.typeTag)[1];
          q.type = /多/.test(tag) ? '多选题' : /判断/.test(tag) ? '判断题' : '单选题';
          q.stem = q.stem.replace(RE.typeTag, '').trim();
        }
        if (!q.answer && q.options.length) {
          // 答案直接写在题干括号里：（ABC）
          const sm = q.stem.match(RE.stemAnswer);
          if (sm) {
            const letters = sm[1].split('').filter(l => q.options.some(o => o.k === l));
            if (letters.length) {
              q.answer = letters.sort().join('');
              q.stem = q.stem.replace(sm[0], '（）');
            }
          }
        }
        if (!q.answer) extractTailAnswer(q);
        if (!q.answer) missingAnswer++;
        if (!q.type) q.type = q.options.length ? (q.answer.length > 1 ? '多选题' : '单选题') : '判断题';
        if (q.type === '判断题' && q.options.length) q.type = q.answer.length > 1 ? '多选题' : '单选题';
        if (!q.answer && q.options.length === 0 && /（\s*[)）]|\(\s*\)/.test(q.stem)) q.type = '判断题';
        q.ans_raw = q.ans_raw || q.answer;
      });
      ch.qs = ch.qs.filter(q => q.stem && q.stem.length >= 2);
      ch.qs.forEach((q, idx) => { q.no = idx + 1; });
    });

    const kept = chapters.filter(ch => ch.qs.length);
    const total = kept.reduce((a, ch) => a + ch.qs.length, 0);
    const withAnswer = kept.reduce((a, ch) => a + ch.qs.filter(q => q.answer).length, 0);
    const stats = {
      total,
      withAnswer,
      noAnswer: total - withAnswer,
      chapters: kept.length,
      byType: countTypes(kept)
    };
    if (!total) warnings.push('没有识别出题目，可能是排版特殊，建议用 AI 解析');
    else if (withAnswer / total < 0.6) warnings.push('答案识别率偏低（' + Math.round(withAnswer / total * 100) + '%），建议用 AI 解析补全');

    return {
      title: P.guessTitle(text, filename),
      subject: '',
      chapters: kept,
      stats,
      warnings,
      rawLength: text.length
    };
  };

  /* 一行里塞了多个选项时切开：A.1950 年前后 B.1980 年前后 C... */
  function expandInlineOptions(k, v) {
    const marker = /\s+([B-H])\s*[.、．)）]\s*/;
    const out = [];
    let curK = k, rest = v, guard = 0;
    while (rest && guard++ < 7) {
      const m = rest.match(marker);
      if (!m) break;
      if (m[1].charCodeAt(0) <= curK.charCodeAt(0)) break;
      const before = rest.slice(0, m.index).trim();
      if (!before) break;
      out.push({ k: curK, v: before });
      curK = m[1];
      rest = rest.slice(m.index + m[0].length);
    }
    if (rest && rest.trim()) out.push({ k: curK, v: rest.trim() });
    return out;
  }

  /* 答案粘在题干末尾的四种写法：
     （√） / 。√ / ? A / 。对 */
  function extractTailAnswer(q) {
    const t = q.stem || '';
    let m;

    // 1) 末尾括号里是判断符号：（√）（×）（对）(X)
    m = t.match(/[（(]\s*([√×✓✗X对错])\s*[)）]\s*$/);
    if (m) {
      q.answer = /[√✓对]/.test(m[1]) ? '√' : 'X';
      q.type = '判断题';
      q.stem = t.slice(0, m.index).trim();
      return true;
    }

    // 2) 句号后紧跟判断符号：。√ 。对
    m = t.match(/[。.？?！!、,，]\s*([√×✓✗对]|错误|错)\s*$/);
    if (m) {
      q.answer = /[√✓对]/.test(m[1]) ? '√' : 'X';
      q.type = '判断题';
      q.stem = t.slice(0, m.index + 1).trim();
      return true;
    }

    // 3) 有选项时，末尾粘了答案字母：? A / ？ABDE
    if (q.options.length >= 2) {
      m = t.match(/[？?。.：:]\s*([A-H]{1,6})\s*$/);
      if (m) {
        const ls = m[1].split('').filter(l => q.options.some(o => o.k === l));
        if (ls.length && ls.length === m[1].length) {
          q.answer = ls.sort().join('');
          q.stem = t.slice(0, m.index + 1).trim();
          return true;
        }
      }
    }

    // 4) 空格后跟判断符号（无选项的判断题）：…权威机构 X
    if (!q.options.length) {
      m = t.match(/\s+([√×✓✗X])\s*$/);
      if (m) {
        q.answer = /[√✓]/.test(m[1]) ? '√' : 'X';
        q.type = '判断题';
        q.stem = t.slice(0, m.index).trim();
        return true;
      }
    }
    return false;
  }

  function applyAnswer(q, raw) {    const r = parseAnswer(raw, q.options.map(o => o.k));
    if (r.answer) q.answer = r.answer;
    if (r.type && !q.type) q.type = r.type;
    q.ans_raw = raw;
  }

  function parseAnswer(raw, keys) {
    let s = (raw || '').trim();
    if (!s) return { answer: '', type: '' };
    s = s.replace(/^[：:=\s]+/, '');
    const judgeTrue = /^(√|✓|对|正确|是|T|TRUE|Y|YES|A)$/i;
    const judgeFalse = /^(×|✗|x|错|错误|否|F|FALSE|N|NO|B)$/i;
    if (!keys.length) {
      if (judgeTrue.test(s)) return { answer: '√', type: '判断题' };
      if (judgeFalse.test(s)) return { answer: 'X', type: '判断题' };
    }
    const letters = (s.toUpperCase().match(/[A-H]/g) || []).filter(l => !keys.length || keys.indexOf(l) >= 0);
    if (letters.length) {
      const uniq = [];
      letters.forEach(l => { if (uniq.indexOf(l) < 0) uniq.push(l); });
      return { answer: uniq.sort().join(''), type: uniq.length > 1 ? '多选题' : '单选题' };
    }
    const first = s.charAt(0);
    if (keys.indexOf(first.toUpperCase()) >= 0) return { answer: first.toUpperCase(), type: '单选题' };
    return { answer: '', type: '' };
  }

  function countTypes(chapters) {
    const o = { 单选题: 0, 多选题: 0, 判断题: 0 };
    chapters.forEach(ch => ch.qs.forEach(q => { o[q.type] = (o[q.type] || 0) + 1; }));
    return o;
  }

  P.guessTitle = function (text, filename) {
    if (filename) {
      const base = filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
      if (base && base.length <= 40) return base;
    }
    const lines = (text || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6);
    for (const l of lines) {
      if (l.length >= 4 && l.length <= 36 && !/^\d/.test(l) && !/^[A-H][.、]/.test(l)) return l.replace(/^#+\s*/, '');
    }
    return '我的题库';
  };

  /* ---------------- 组装题库 ---------------- */
  P.makeBank = function ({ title, subject, chapters, source_kind, source_name }) {
    const clean = (chapters || []).filter(ch => ch.qs && ch.qs.length);
    return {
      title: title || '未命名题库',
      subject: subject || '',
      courses: [{
        key: 'main',
        course: title || '未命名题库',
        short: (title || '题库').slice(0, 12),
        chapters: clean
      }],
      meta: { source_kind: source_kind || 'manual', source_name: source_name || '', created: Date.now() }
    };
  };

  P.countQuestions = function (bank) {
    let n = 0;
    (bank.courses || []).forEach(c => (c.chapters || []).forEach(ch => { n += (ch.qs || []).length; }));
    return n;
  };

  P.flatten = function (bank) {
    const list = [];
    const used = {};
    (bank.courses || []).forEach(c => {
      (c.chapters || []).forEach((ch, ci) => {
        const sec = ch.sec || String(ci + 1);
        const main = String(sec).split('.')[0] || String(ci + 1);
        (ch.qs || []).forEach(q => {
          let id = c.key + '|' + sec + '|' + q.no;
          if (used[id]) id += '#' + (used[id]++);
          else used[id] = 1;
          list.push({
            id, no: q.no, type: q.type || '单选题', stem: q.stem,
            options: q.options || [], answer: q.answer || '', note: q.note || '',
            sec, secName: ch.name || ch.title || '', main,
            courseKey: c.key
          });
        });
      });
    });
    return list;
  };

  P.chapterMeta = function (bank, courseKey) {
    const c = (bank.courses || []).find(x => x.key === courseKey) || (bank.courses || [])[0];
    if (!c) return [];
    return (c.chapters || []).map((ch, i) => {
      const sec = ch.sec || String(i + 1);
      return {
        sec, title: ch.title || ch.name || sec, name: ch.name || ch.title || sec,
        main: String(sec).split('.')[0] || String(i + 1),
        count: (ch.qs || []).length
      };
    });
  };

  /* ---------------- 给 AI 切块 ---------------- */
  P.splitForAI = function (text, size, maxChunks) {
    const t = clean(text);
    const limit = size || 4200;
    const max = maxChunks == null ? Infinity : maxChunks;
    if (t.length <= limit) return [t];
    const lines = t.split('\n');
    const chunks = [];
    let cur = '';
    for (const line of lines) {
      // 尽量在题号之前分段，避免同一题的选项和答案落到下一段。
      if (cur && cur.length + line.length + 1 > limit && /^(?:第\s*)?\d{1,5}\s*[.、．)）]|^[（(]\s*\d{1,5}\s*[)）]/.test(line)) {
        chunks.push(cur);
        cur = '';
      }
      if (cur && cur.length + line.length + 1 > limit) {
        chunks.push(cur);
        cur = '';
      }
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          const part = line.slice(i, i + limit);
          if (part.length === limit) chunks.push(part);
          else cur = part + '\n';
        }
        continue;
      }
      cur += line + '\n';
    }
    if (cur) chunks.push(cur);
    return chunks.slice(0, max);
  };

  Q.parse = P;
})(window.Q);
