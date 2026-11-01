/* 题库 PDF：用浏览器的打印排版保留中文、分页与每页水印。 */
window.Q = window.Q || {};
(function (Q) {
  'use strict';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function buildHtml(bank) {
    const courses = bank.courses || [];
    const count = courses.reduce((total, course) => total + (course.chapters || []).reduce(
      (sum, chapter) => sum + (chapter.qs || []).length, 0), 0);
    let serial = 0;
    const content = courses.map(course => {
      const chapters = (course.chapters || []).filter(chapter => (chapter.qs || []).length);
      if (!chapters.length) return '';
      const courseName = courses.length > 1 ? '<h2 class="course">' + esc(course.course || course.short || '课程') + '</h2>' : '';
      return courseName + chapters.map(chapter => '<section class="chapter">'
        + '<h3>' + esc(chapter.title || chapter.name || '未命名章节') + '</h3>'
        + chapter.qs.map(question => {
          serial += 1;
          const options = (question.options || []).map(option => '<li><b>' + esc(option.k) + '.</b> '
            + esc(option.v) + '</li>').join('');
          return '<article class="question"><div class="stem"><b>' + serial + '.</b> '
            + esc(question.stem) + '<span class="type">' + esc(question.type || '单选题') + '</span></div>'
            + (options ? '<ul class="options">' + options + '</ul>' : '')
            + '<p class="answer"><b>参考答案：</b>' + esc(question.answer || '未录入') + '</p>'
            + (question.note ? '<p class="note"><b>解析：</b>' + esc(question.note) + '</p>' : '')
            + '</article>';
        }).join('') + '</section>').join('');
    }).join('');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>'
      + esc(bank.title || '题库') + ' - 题目与答案</title><style>'
      + '@page{size:A4;margin:18mm 17mm 23mm}'
      + 'body{font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:#1d2734;font-size:11pt;line-height:1.65;margin:0}'
      + 'h1{font-size:21pt;line-height:1.3;margin:0 0 5mm}h2{font-size:15pt;margin:10mm 0 3mm}h3{font-size:12pt;margin:7mm 0 3mm;color:#243b61}'
      + '.meta{color:#667085;font-size:9pt;margin:0 0 9mm}.chapter h3{break-after:avoid-page;page-break-after:avoid}'
      + '.question{margin:0 0 6mm;break-inside:avoid-page;page-break-inside:avoid}.stem,.options li,.answer,.note{white-space:pre-wrap;overflow-wrap:anywhere}'
      + '.stem{font-weight:500}.type{font-size:9pt;color:#667085;margin-left:3mm}.options{list-style:none;padding:0;margin:2mm 0 2mm 5mm}.options li{margin:1mm 0}'
      + '.answer,.note{margin:2mm 0 0 5mm}.answer{color:#176146}.note{color:#475467}'
      + '.watermark{position:fixed;right:0;bottom:0;color:#98a2b3;font-size:8pt;letter-spacing:.03em;pointer-events:none}'
      + '@media screen{body{max-width:176mm;margin:20mm auto;padding:0 12mm}.watermark{position:fixed;right:16px;bottom:12px;background:#fff}}'
      + '</style></head><body><div class="watermark">网络整理，侵删。</div>'
      + '<h1>' + esc(bank.title || '题库') + '</h1><p class="meta">共 ' + count + ' 题 · 题目与答案</p>'
      + content + '</body></html>';
  }

  function open(bank) {
    if (!bank || !(bank.courses || []).some(course => (course.chapters || []).some(chapter => (chapter.qs || []).length))) {
      throw new Error('这套题库没有可导出的题目');
    }
    const win = window.open('', '_blank');
    if (!win) throw new Error('浏览器拦截了导出页面，请允许弹出窗口后重试');
    win.document.open();
    win.document.write(buildHtml(bank));
    win.document.close();
    win.focus();
    win.setTimeout(() => win.print(), 300);
  }

  Q.exportPdf = { buildHtml, open };
})(window.Q);
