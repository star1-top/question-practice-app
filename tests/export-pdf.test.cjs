const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let printed = false;
let written = '';
const popup = {
  document: { open() {}, write(html) { written = html; }, close() {} },
  focus() {}, setTimeout(fn) { fn(); }, print() { printed = true; }
};
const context = { window: { Q: {}, open: () => popup } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/assets/export-pdf.js'), 'utf8'), context);
const exporter = context.window.Q.exportPdf;
const bank = { title: '测试 <题库>', courses: [{ course: '课程', chapters: [{ title: '第一章', qs: [
  { type: '单选题', stem: '哪一项 <正确>？', options: [{ k: 'A', v: '甲 & 乙' }], answer: 'A', note: '解析内容' },
  { type: '判断题', stem: '判断题', answer: '√' }
] }] }] };

exporter.open(bank);
assert.equal(printed, true);
for (const value of ['哪一项 &lt;正确&gt;？', '甲 &amp; 乙', '参考答案：</b>A', '解析内容',
  '参考答案：</b>√', '网络整理，侵删。', 'position:fixed;right:0;bottom:0']) {
  assert.ok(written.includes(value), `PDF 页面缺少：${value}`);
}
assert.ok(!written.includes('<正确>'));
assert.throws(() => exporter.open({ courses: [] }), /没有可导出的题目/);
console.log('PDF 导出测试通过：题目、选项、答案、解析、转义、水印和空题库');
