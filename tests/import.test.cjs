const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const assets = path.join(__dirname, '../app/assets');
const window = { Q: {}, Q_CONFIG: { ai: { chunkChars: 4200, provider: 'proxy', proxy: { url: '' } } } };
const context = vm.createContext({ window, TextDecoder, console });
for (const file of ['parse.js', 'ai.js']) {
  vm.runInContext(fs.readFileSync(path.join(assets, file), 'utf8'), context, { filename: file });
}
const parse = window.Q.parse;
const ai = window.Q.ai;

function bankText(count) {
  let text = '# 综合练习\n';
  for (let i = 1; i <= count; i++) {
    if (i % 50 === 1) text += `第${Math.ceil(i / 50)}章 基础\n`;
    text += `${i}. 第${i}题：下列说法哪项正确？\nA. 选项一\nB. 选项二\nC. 选项三\nD. 选项四\n答案：B\n`;
  }
  return text;
}

async function run() {
  for (const count of [5, 100, 1050]) {
    const text = bankText(count);
    const result = parse.fromText(text, '练习.txt');
    assert.equal(result.stats.total, count, `${count} 题必须全部识别`);
    assert.equal(result.stats.withAnswer, count, '答案必须全部保留');
    const chunks = parse.splitForAI(text, 4200);
    assert.equal(chunks.join('').replace(/\n/g, ''), text.replace(/\n/g, ''), '分段不能丢失文本');
    assert.ok(chunks.length > 3 || count < 1050, '长文档不能截断为三段');
  }

  ai.chat = async () => JSON.stringify({ chapters: [{ title: '题目', questions: [
    { stem: '模拟 AI 只返回一道题', options: [{ k: 'A', v: '一' }, { k: 'B', v: '二' }], answer: 'B' }
  ] }] });
  const result = await ai.parseBank(bankText(120));
  assert.equal(result.total, 120, 'AI 漏题时不能覆盖规则解析出的题目');
  assert.ok(result.warnings.length > 0, '漏题时应在预览给出提示');
  console.log('导入测试通过：5 / 100 / 1050 题、长文分段、AI 漏题回退');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
