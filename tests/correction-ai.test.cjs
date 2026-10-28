const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const calls = [];
const client = { llm: {
  models: { list: async () => [
    { id: 'text-fast', supportsImages: false },
    { id: 'vision-fast', supportsImages: true }
  ] },
  chat: { completions: { create: async function* (params) {
    calls.push(params);
    const content = params.model === 'vision-fast'
      ? '{"matched":true,"answer_visible":true,"visible_stem":"测试题","visible_options":[{"k":"B","v":"正确"}],"visible_answer":"B","evidence_text":"答案B","uncertainty":""}'
      : 'ok';
    yield { choices: [{ delta: { content } }] };
  } } }
} };
const window = {
  Q_CONFIG: { ai: { provider: 'workbuddy', preferModels: ['text-fast', 'vision-fast'], temperature: 0.3 } },
  Q: { cloud: { client } }
};
const context = vm.createContext({ window, console });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../app/assets/ai.js'), 'utf8'), context);

(async () => {
  await window.Q.ai.chat([{ role: 'user', content: 'hello' }]);
  const result = await window.Q.ai.recognizeCorrectionScreenshot('data:image/png;base64,AA==', {
    stem: '测试题', options: [{ k: 'A', v: '错误' }, { k: 'B', v: '正确' }], answer: 'A'
  });
  assert.equal(calls[0].model, 'text-fast');
  assert.equal(calls[1].model, 'vision-fast', '截图识别必须选支持图片的模型');
  assert.equal(calls[1].messages[1].content[1].type, 'image_url');
  assert.equal(result.visible_answer, 'B');
  assert.equal(result.visible_options[0].v, '正确');
  console.log('纠错 AI 测试通过：图片模型选择、截图消息与识别结果');
})().catch(error => { console.error(error); process.exitCode = 1; });
