/* 全局配置：云端环境 + AI 服务开关 */
window.Q_CONFIG = {
  cloud: {
    endpoint: 'https://quiz-bank-pro.app.workbuddy.host',
    publishableKey: 'wbpk_wjmy5ySLIW6Z5NxLHHyHVZ_9947jfnoZikWDusy3nWWc9eY10cQeMYL'
  },
  ai: {
    /**
     * provider = 'workbuddy'：走平台托管大模型，密钥不下发浏览器（当前默认）。
     * provider = 'proxy'：走你自己的后端代理（推荐接 DeepSeek 时用）。
     *   proxy.url 指向你的服务，例如 https://api.yourdomain.com/ai/chat
     *   你的服务端持有 DEEPSEEK_API_KEY，接收 {messages, temperature, response_format} 并流式转发。
     * 不要在这里填 DeepSeek / OpenAI 的原始 Key —— 前端代码是公开的，填了就等于公开密钥。
     */
    provider: 'workbuddy',
    proxy: {
      url: '',
      model: 'deepseek-chat'
    },
    maxInputChars: 26000,
    chunkChars: 4200,
    temperature: 0.35,
    /**
     * 模型优先级（按 id 精确匹配，取第一个可用的）。
     * DeepSeek 系列在平台上的积分倍率最低（v4.1-flash ≈ x0.11），
     * 所以默认都排在前面；想换模型时改这个数组即可，不用动 ai.js。
     */
    preferModels: ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']
  },
  /** 联系方式：题库页与兑换码充值页共用 */
  contact: {
    qq: '2053256933'
  },
  defaults: {
    freeCredits: 1,
    cost: { ai_import: 0, ai_notes: 1, ai_find: 3 },
    packs: [
      { id: 'pack_10', credits: 10, price: 9.9, label: '10 次' },
      { id: 'pack_30', credits: 30, price: 24.9, label: '30 次', hot: true }
    ]
  }
};
