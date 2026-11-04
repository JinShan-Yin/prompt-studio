// Sprint2 Lead E2E Phase 4：多轮对话模拟器（真实 DeepSeek，两轮，抓包验证历史递增）
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, timeout = 120000, interval = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await sleep(interval);
    }
    return null;
  }
  const findTree = (t) => Array.from(document.querySelectorAll('.menu-child')).find((e) => e.textContent.includes(t));
  const S = window.__s2;
  // 切到 Trip 项目（有语境/知识库）
  findTree('Trip旅游AI接线员').click();
  await waitUntil(() => document.getElementById('main-content') && document.getElementById('main-content').style.display === 'block', 10000);
  await sleep(900);
  // 设置提示词层与语境
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
  setVal('val-L0', '你是一个面向 {{industry}} 领域的智能语音客服助手。当前业务场景：{{business_scene}}。\n回复要求：自然口语，必须整体使用 <speak> 标签包裹，禁止 Markdown。');
  setVal('val-L1', '语音基座：保持礼貌、简洁。');
  setVal('val-L3', '项目话术：停车场首小时8元，全天封顶50元；营业时间每天9:00-21:00。');
  const ind = document.getElementById('ctx-industry');
  if (ind) { ind.value = '商场客服'; ind.dispatchEvent(new Event('input', { bubbles: true })); }
  await sleep(1200); // 等语境自动保存/标签稳定

  const bubbles = () => document.querySelectorAll('#chat-messages .chat-bubble').length;
  const chatBox = document.getElementById('chat-messages');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send-btn');
  if (!chatBox || !input || !sendBtn) return { pass: false, fatal: '未找到聊天模拟器元素' };
  const chatReqsBefore = S.chatReqs.length;

  async function send(msg) {
    input.value = msg;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    sendBtn.click();
    return await waitUntil(() => S.chatReqs.length > chatReqsBefore + (window.__s2.__turn || 0), 120000, 300);
  }
  window.__s2.__turn = 0;
  const sent1 = await send('你好，请问停车场怎么收费？');
  const wait1 = await waitUntil(() => S.chatReqs.length >= chatReqsBefore + 1 && bubbles() >= 2, 120000, 300);
  await waitUntil(() => !document.querySelector('#chat-send-btn').disabled, 120000, 200);
  const after1 = {
    requests: S.chatReqs.length - chatReqsBefore,
    bubbles: bubbles(),
    lastText: (chatBox.lastElementChild ? chatBox.lastElementChild.innerText : '').slice(0, 300),
    pendingLeft: !!chatBox.querySelector('.chat-bubble.pending, .chat-bubble[data-pending="1"]'),
    sendEnabled: !sendBtn.disabled
  };
  window.__s2.__turn = 1;
  const sent2 = await send('那会员有什么优惠？');
  const wait2 = await waitUntil(() => S.chatReqs.length >= chatReqsBefore + 2 && bubbles() >= 4, 120000, 300);
  await waitUntil(() => !document.querySelector('#chat-send-btn').disabled, 120000, 200);
  const reqs = S.chatReqs.slice(chatReqsBefore);
  const after2 = {
    requests: S.chatReqs.length - chatReqsBefore,
    bubbles: bubbles(),
    lastText: (chatBox.lastElementChild ? chatBox.lastElementChild.innerText : '').slice(0, 300),
    sendEnabled: !sendBtn.disabled,
    turn1Messages: reqs[0] ? reqs[0].messages.length : -1,
    turn2Messages: reqs[1] ? reqs[1].messages.length : -1,
    hasLayers: !!(reqs[0] && Array.isArray(reqs[0].layers) && reqs[0].layers.length >= 2),
    hasContext: !!(reqs[0] && reqs[0].context_data && reqs[0].context_data.industry === '商场客服'),
    turn2HasPriorAssistant: !!(reqs[1] && reqs[1].messages.some((m) => m.role === 'assistant')),
    replies: reqs.map((r) => (r.messages.filter((m) => m.role === 'assistant').slice(-1)[0] || {}).content || '')
  };
  // 清空对话
  const clearBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('清空对话'));
  if (clearBtn) clearBtn.click();
  await sleep(300);
  const afterClear = bubbles();
  return {
    pass: !!(wait1 && wait2 && after1.requests >= 1 && after2.requests >= 2 && after2.bubbles >= 4 && after2.turn1Messages === 1 && after2.turn2Messages >= 3 && after2.hasLayers && after2.hasContext && after2.turn2HasPriorAssistant && afterClear === 0),
    after1, after2, afterClear,
    clearBtnFound: !!clearBtn
  };
});
console.log('@@DSH_RESULT@@' + JSON.stringify(out));