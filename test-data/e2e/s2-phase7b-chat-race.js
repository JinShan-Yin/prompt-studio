// Sprint2 Lead E2E Phase 7b：聊天在途切项目（P2-2）真机复验
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 10000, interval = 120) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(interval); }
    return null;
  }
  const token = new URLSearchParams(location.search).get('token') || '';
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const S = window.__s2r || (window.__s2r = { errors: [], chatReqs: [] });
  S.chatReqs = S.chatReqs || [];
  S.errors = S.errors || [];
  if (!S.fetchPatched) {
    S.fetchPatched = true;
    const orig = window.fetch.bind(window);
    window.fetch = async function (url, opts) {
      const u = String(url || '');
      try { if (u.includes('/api/chat/reply')) S.chatReqs.push(JSON.parse(opts.body)); } catch (e) {}
      return orig(url, opts);
    };
  }
  const select = async (name) => {
    findTree(name).click();
    await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 8000);
    await sleep(800);
  };
  const bubbles = () => document.querySelectorAll('#chat-messages .chat-bubble').length;
  await select('Trip旅游AI接线员');
  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send-btn');
  input.value = '你好，请介绍一下停车收费。';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  send.click();
  await sleep(200);
  await select('途牛热线'); // LLM 在途切项目
  const early = { bubbles: bubbles(), sendDisabled: !!document.getElementById('chat-send-btn') && document.getElementById('chat-send-btn').disabled };
  await sleep(9000); // 等旧响应回来
  const r = {
    chatReqs: S.chatReqs.length,
    earlyBubbles: early.bubbles,
    bubblesAfter: bubbles(),
    sendEnabled: !document.getElementById('chat-send-btn').disabled,
    errors: S.errors.slice(),
    pass: early.bubbles === 0 && bubbles() === 0 && !document.getElementById('chat-send-btn').disabled && S.errors.length === 0
  };
  await select('Trip旅游AI接线员');
  return r;
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));