// Chat with the selected AI provider. One component, embedded in the Copilot tab or in the current view.
import { api, post, put, get, store, on } from './api.js';
import { h, $, toast, esc, SERVER_LABEL } from './ui.js';
import { md } from './md.js';
import { applyModelProposal, proposalCounts } from './views/model.js';
import { applyReportProposal, reportProposalText } from './views/reports.js';
import { applyDataAgentProposal, dataAgentProposalText } from './views/share.js';

let root;               // component root element
let msgsEl, inputEl, sendBtn, titleEl, providerEl, modelSel, histSel, closeBtn, footEl;
let chatId = null;
let busyState = false;
let streamBubble = null;
let streamText = '';
let thinkEl = null;
let turnProposal = null; // shown when Copilot finishes its answer, so the button sits below the explanation
let turnText = '';       // Copilot's last message this turn (does it ask for a go-ahead?)
const toolCards = new Map();
let suggestionsFn = () => [];
let onCloseFn = () => {};

export function chatElement({ suggestions, onClose }) {
  suggestionsFn = suggestions || suggestionsFn;
  onCloseFn = onClose || onCloseFn;
  if (root) return root;

  titleEl = h('span', {}, 'Copilot');
  providerEl = h('span', { class: 'provider', title: 'AI provider – change it in Settings' }, '…');
  modelSel = h('select', { class: 'mini', title: 'Model', onchange: async () => { try { await put('/providers', { id: 'github', model: modelSel.value }); toast(`Model set to ${modelSel.value} for new chats`); } catch (e) { toast(e.message, 'err'); } } });
  histSel = h('select', { class: 'mini', title: 'Recent chats', onchange: () => { if (histSel.value) loadChat(histSel.value); } });
  closeBtn = h('button', { class: 'mini', title: 'Hide Copilot', onclick: () => onCloseFn() }, '✕');

  msgsEl = h('div', { class: 'msgs' });
  inputEl = h('textarea', { rows: 1, placeholder: 'Ask Copilot to build, explain or answer… (Enter to send, Shift+Enter for a new line)' });
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  inputEl.addEventListener('input', autosize);
  sendBtn = h('button', { class: 'sendbtn', title: 'Send', onclick: () => (busyState ? stop() : submit()) }, '➤');
  footEl = h('div', { class: 'chatfoot' }, 'Changes in Fabric always ask for your approval first.');

  root = h('div', { class: 'chat' },
    h('div', { class: 'chathd' },
      h('div', { class: 'ttl' }, h('span', {}, '✦'), titleEl),
      providerEl, modelSel, histSel,
      h('button', { class: 'mini', title: 'New chat', onclick: () => newChat() }, '＋ New'),
      closeBtn),
    msgsEl,
    h('div', { class: 'composer' }, inputEl, sendBtn),
    footEl);

  wireEvents();
  renderWelcome();
  refreshHeader();
  return root;
}

export function setPanelMode(isPanel) { if (closeBtn) closeBtn.hidden = !isPanel; }

/** Keep the latest messages in view after the chat moves to another place in the page. */
export function scrollChatToEnd() { if (msgsEl) requestAnimationFrame(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }); }

export function focusChat() { if (inputEl) setTimeout(() => inputEl.focus({ preventScroll: true }), 300); }

function autosize() { inputEl.style.height = 'auto'; inputEl.style.height = `${Math.min(160, inputEl.scrollHeight)}px`; }

export async function refreshHeader() {
  if (!root) return;
  const p = store.provider || {};
  providerEl.textContent = `${p.name || 'AI'}${p.id !== 'github' && p.model ? ` · ${p.model}` : ''}`;
  modelSel.hidden = p.id !== 'github';
  if (p.id === 'github' && !modelSel.options.length) {
    try {
      const models = await get('/copilot/models');
      modelSel.innerHTML = '';
      for (const m of models) modelSel.append(h('option', { value: m.id, selected: m.id === (p.model || 'auto') || undefined }, m.id === 'auto' ? 'auto (best available)' : m.name));
    } catch { modelSel.hidden = true; }
  }
  try {
    const chats = await get('/chats');
    histSel.innerHTML = '';
    histSel.append(h('option', { value: '' }, chats.length ? `History (${chats.length})` : 'History'));
    for (const c of chats) histSel.append(h('option', { value: c.id, selected: c.id === chatId || undefined }, c.title.slice(0, 40)));
  } catch { /* ignore */ }
}

function scrollDown() { msgsEl.scrollTop = msgsEl.scrollHeight; }

function renderWelcome() {
  msgsEl.innerHTML = '';
  const model = store.project?.semanticModel?.name;
  const chips = h('div', { class: 'chips mt' }, suggestionsFn().map((s) => h('button', { class: 'chip', onclick: () => ask(s) }, s)));
  msgsEl.append(h('div', { class: 'welcome' },
    h('h3', {}, model ? 'What would you like to know?' : 'What would you like to build?'),
    h('p', { class: 'muted small' }, model
      ? `Ask about your business in plain language. Answers come from "${model}" through Fabric IQ, with your permissions – and I can also build and change things in Fabric, asking before any change.`
      : 'I can create your workspace, bring in data, design the semantic model and ontology, and answer business questions – using Microsoft Fabric MCP servers as you. I ask before changing anything.'),
    chips));
}

export function refreshSuggestions() {
  if (!root || chatId) return;
  renderWelcome();
}

function addMsg(role, content) {
  const bub = h('div', { class: 'bub' });
  if (role === 'bot') bub.innerHTML = md(content);
  else bub.textContent = content;
  const el = h('div', { class: `msg ${role}` }, bub);
  msgsEl.append(el);
  scrollDown();
  return bub;
}

function toolCard(t) {
  let card = toolCards.get(t.id);
  const server = t.server || 'built-in';
  const status = t.status === 'running' ? h('span', { class: 'spin' }) : h('span', {}, t.status === 'failed' ? '✗' : '✓');
  const head = h('div', { class: 'th', onclick: () => card.classList.toggle('open') },
    status,
    h('span', { class: `srv ${server}` }, SERVER_LABEL[server] || server),
    h('span', { class: 'nm', title: t.name }, prettyTool(t)),
    t.write ? h('span', { class: 'wbadge', title: 'This call changes something in Fabric' }, 'change') : null,
    h('span', { class: 'ms' }, t.ms ? `${(t.ms / 1000).toFixed(1)}s` : ''));
  const bodyEl = h('div', { class: 'tb' },
    h('div', { class: 'tiny muted' }, 'Input'), h('pre', {}, t.args || '{}'),
    t.result ? [h('div', { class: 'tiny muted' }, 'Result'), h('pre', {}, prettyResult(t.result))] : null);
  if (!card) {
    card = h('div', { class: 'tcard' });
    toolCards.set(t.id, card);
    msgsEl.append(h('div', { class: 'msg bot' }, card));
  }
  const open = card.classList.contains('open');
  card.innerHTML = '';
  card.append(head, bodyEl);
  if (open || t.status === 'failed') card.classList.add('open');
  scrollDown();
}

function prettyTool(t) {
  const n = String(t.tool || t.name || '').replace(/^studio_/, '').replace(/[_-]+/g, ' ');
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function prettyResult(r) {
  try { return JSON.stringify(JSON.parse(r), null, 2).slice(0, 6000); } catch { return String(r).slice(0, 6000); }
}

// ---- Copilot's suggestions: one-click apply ----
const PROPOSALS = {
  'semantic-model': { key: 'modelProposal', title: 'Semantic model design ready', text: (pr) => proposalCounts(pr), apply: (pr) => applyModelProposal(pr), hint: 'Review it, then create it in one click.' },
  report: { key: 'reportProposal', title: 'Power BI report ready to build', text: (pr) => reportProposalText(pr), apply: (pr) => applyReportProposal(pr), hint: 'Review it, then build it in one click.' },
  'data-agent': { key: 'dataAgentProposal', title: 'Fabric data agent ready to create', text: (pr) => dataAgentProposalText(pr), apply: (pr) => applyDataAgentProposal(pr), hint: 'Review the instructions, then create it in one click.' },
};
const kindOf = (pr) => (PROPOSALS[pr?.kind] ? pr.kind : 'semantic-model');
const currentOf = (kind) => store.project?.[PROPOSALS[kind].key] || null;

// Any other recommendation that waits for the user's go-ahead gets an Apply button too: either Copilot offers it
// (studio_suggest_apply, with the exact request) or the answer ends by asking for a go-ahead ("Shall I create it?",
// "Confirm these rules and I'll deploy…"). Statements like "let me know if you have questions" don't count.
const GO_AHEAD = 'Yes – go ahead.';
function looksLikeConfirmation(text) {
  const tail = String(text || '').trim().slice(-320);
  if (/\b(confirm|approve)\b[^.?!\n]*\b(and|then)\s+i(['’]ll| will)\b/i.test(tail)) return true;
  if (!/\?[\s*_)]*$/.test(tail)) return false;
  const last = tail.split(/(?<=[.!?])\s+/).pop();
  return /\b(shall i|should i|do you want me to|want me to|would you like me to|ok(ay)? to|go ahead|ready to|proceed)\b/i.test(last);
}

function actionCard(pr, { answered = false } = {}) {
  const generic = pr.kind === 'confirm';
  const state = h('span', { class: 'pstate small muted' }, generic ? 'Copilot is asking for your go-ahead.' : 'Copilot does this when you select Apply.');
  const card = h('div', { class: 'pcard', 'data-action': pr.id, 'data-kind': pr.kind });
  const done = (text, ok = true) => { card.dataset.applied = '1'; card.querySelectorAll('button').forEach((b) => { b.hidden = true; }); state.textContent = text; state.classList.toggle('ok', ok); };
  const apply = h('button', { class: 'btn pri', onclick: async () => { if (busyState) { toast('Copilot is still working. Stop it or wait.', 'err'); return; } done(generic ? '✓ Sent – Copilot is on it' : '✓ Applied – Copilot is on it'); await ask(pr.instruction || GO_AHEAD); } }, generic ? '✓ Yes, go ahead' : '✓ Apply');
  const change = h('button', { class: 'btn ghost', onclick: () => { inputEl.focus(); inputEl.placeholder = 'Tell Copilot what to change…'; } }, generic ? 'Something else' : 'Change something');
  card.append(
    h('div', { class: 'ph' }, h('span', {}, '✦'), pr.title || 'Copilot is waiting for your go-ahead'),
    pr.summary ? h('div', { class: 'small muted' }, pr.summary) : null,
    h('div', { class: 'row' }, apply, change, state));
  if (answered) done('✓ Applied');
  return h('div', { class: 'msg bot' }, card);
}

/** Generic go-ahead cards only make sense until the user answers. */
function retireConfirmCards() {
  msgsEl.querySelectorAll('.pcard[data-kind="confirm"]:not([data-applied])').forEach((c) => c.closest('.msg')?.remove());
}

function proposalCard(pr) {
  const kind = kindOf(pr);
  const def = PROPOSALS[kind];
  const btn = h('button', { class: 'btn pri', onclick: () => def.apply(currentOf(kind)?.id === pr.id ? currentOf(kind) : pr) }, '✓ Apply suggestions');
  const card = h('div', { class: 'pcard', 'data-proposal': pr.id, 'data-kind': kind },
    h('div', { class: 'ph' }, h('span', {}, '✦'), def.title),
    pr.name ? h('div', { class: 'small muted' }, def.text(pr)) : null,
    h('div', { class: 'row' }, btn, h('span', { class: 'pstate small muted' }, def.hint)));
  syncProposalCard(card);
  return h('div', { class: 'msg bot' }, card);
}

function syncProposalCard(card) {
  const def = PROPOSALS[card.dataset.kind] || PROPOSALS['semantic-model'];
  const cur = currentOf(card.dataset.kind || 'semantic-model');
  const btn = $('button', card);
  const state = $('.pstate', card);
  const mine = cur?.id === card.dataset.proposal;
  if (mine && cur.appliedAt) card.dataset.applied = '1';
  const applied = card.dataset.applied === '1';
  btn.hidden = !mine || applied;
  state.textContent = applied ? '✓ Applied' : !mine ? (cur ? 'Replaced by newer suggestions.' : 'No longer available.') : def.hint;
  state.classList.toggle('ok', applied);
}

function flushProposal() {
  if (!turnProposal) return;
  msgsEl.append(turnProposal.kind === 'action' ? actionCard(turnProposal, { answered: turnProposal.answered }) : proposalCard(turnProposal));
  turnProposal = null;
  scrollDown();
}

/** At the end of a turn: Copilot's suggestion card, or a go-ahead card when the answer asks to confirm. */
function finishTurn() {
  if (turnProposal) flushProposal();
  else if (looksLikeConfirmation(turnText)) { msgsEl.append(actionCard({ id: `confirm-${Date.now()}`, kind: 'confirm' })); scrollDown(); }
  turnText = '';
}

function setBusy(b) {
  busyState = b;
  sendBtn.textContent = b ? '■' : '➤';
  sendBtn.classList.toggle('stop', b);
  sendBtn.title = b ? 'Stop' : 'Send';
  footEl.textContent = b ? 'Working… you can stop at any time.' : 'Changes in Fabric always ask for your approval first.';
}

function endStream() {
  if (streamBubble) streamBubble.classList.remove('cursor');
  streamBubble = null;
  streamText = '';
}

function wireEvents() {
  const mine = (e) => e.chatId && e.chatId === chatId;
  on('chat.user', (e) => { if (mine(e) && !e._local) { /* already rendered locally */ } });
  on('chat.delta', (e) => {
    if (!mine(e)) return;
    if (!streamBubble) { streamBubble = addMsg('bot', ''); streamBubble.classList.add('cursor'); }
    streamText += e.delta;
    streamBubble.innerHTML = md(streamText);
    scrollDown();
  });
  on('chat.reasoning.delta', (e) => {
    if (!mine(e)) return;
    if (!thinkEl) {
      thinkEl = h('div');
      msgsEl.append(h('details', { class: 'think' }, h('summary', {}, 'Thinking…'), thinkEl));
    }
    thinkEl.textContent += e.delta;
  });
  on('chat.message', (e) => {
    if (!mine(e)) return;
    if (streamBubble) streamBubble.innerHTML = md(e.content);
    else addMsg('bot', e.content);
    turnText = e.content;
    endStream();
    thinkEl = null;
    scrollDown();
  });
  on('chat.tool.start', (e) => { if (mine(e)) { endStream(); thinkEl = null; toolCard(e.tool); } });
  on('chat.tool.done', (e) => { if (mine(e)) toolCard(e.tool); });
  on('chat.proposal', (e) => { if (mine(e)) turnProposal = e.proposal; });
  on('chat.idle', (e) => { if (mine(e)) { endStream(); finishTurn(); setBusy(false); refreshHeader(); } });
  on('chat.error', (e) => { if (mine(e)) { endStream(); flushProposal(); turnText = ''; addMsg('err', e.message); setBusy(false); } });
  on('chat.title', (e) => { if (mine(e)) titleEl.textContent = e.title; });
  on('provider', () => { modelSel.innerHTML = ''; refreshHeader(); });
  on('project.updated', () => { if (msgsEl) msgsEl.querySelectorAll('.pcard[data-proposal]').forEach(syncProposalCard); });
}

async function ensureChat() {
  if (chatId) return chatId;
  const c = await post('/chats');
  chatId = c.id;
  store.activeChat = chatId;
  titleEl.textContent = c.title;
  msgsEl.innerHTML = '';
  toolCards.clear();
  refreshHeader();
  return chatId;
}

export async function newChat() {
  chatId = null;
  store.activeChat = null;
  titleEl.textContent = 'Copilot';
  toolCards.clear();
  turnProposal = null;
  turnText = '';
  endStream();
  setBusy(false);
  renderWelcome();
}

export async function loadChat(id) {
  try {
    const c = await get(`/chats/${id}`);
    chatId = id;
    store.activeChat = id;
    titleEl.textContent = c.title;
    msgsEl.innerHTML = '';
    toolCards.clear();
    endStream();
    turnProposal = null;
    turnText = '';
    // Suggestion cards go after Copilot's explanation of that turn, as they did live.
    const tr = c.transcript;
    // An Apply card counts as applied when the next message is its own request (what the button sends).
    const appliedBy = (i, instruction) => tr.slice(i + 1).find((x) => x.role === 'user')?.content?.trim() === String(instruction || '').trim();
    let turnHadProposal = false;
    tr.forEach((m, i) => {
      if (m.role === 'user') { flushProposal(); turnHadProposal = false; addMsg('user', m.content); } else if (m.role === 'assistant') addMsg('bot', m.content);
      else if (m.role === 'error') addMsg('err', m.content);
      else if (m.role === 'tool') toolCard(m);
      else if (m.role === 'proposal' && m.kind === 'action') { flushProposal(); turnHadProposal = true; turnProposal = { id: m.proposalId, kind: 'action', title: m.title, summary: m.summary, instruction: m.instruction, answered: appliedBy(i, m.instruction) }; }
      else if (m.role === 'proposal') { flushProposal(); turnHadProposal = true; const kind = PROPOSALS[m.kind] ? m.kind : 'semantic-model'; turnProposal = currentOf(kind)?.id === m.proposalId ? currentOf(kind) : { id: m.proposalId, kind }; }
    });
    const last = tr[tr.length - 1];
    if (c.busy) setBusy(true);
    else {
      flushProposal();
      // The last answer still asks for a go-ahead (and offered no Apply card): offer it again.
      if (!turnHadProposal && last?.role === 'assistant' && looksLikeConfirmation(last.content)) msgsEl.append(actionCard({ id: `confirm-${Date.now()}`, kind: 'confirm' }));
      setBusy(false);
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function submit() {
  const text = inputEl.value.trim();
  if (!text || busyState) return;
  inputEl.value = '';
  autosize();
  await ask(text);
}

export async function ask(text) {
  if (busyState) { toast('Copilot is still working. Stop it or wait.', 'err'); return; }
  setBusy(true);
  try {
    const welcome = $('.welcome', msgsEl);
    if (welcome) welcome.remove();
    retireConfirmCards();
    await ensureChat();
    addMsg('user', text);
    await post(`/chats/${chatId}/messages`, { prompt: text });
  } catch (e) {
    setBusy(false);
    addMsg('err', friendlyError(e));
  }
}

function friendlyError(e) {
  if (e.code === 'AUTH_REQUIRED') return 'Sign in to Microsoft Fabric first (top right).';
  if (/not authenticated|login|unauthorized/i.test(e.message)) return `${e.message} – check Settings › AI provider.`;
  return e.message;
}

async function stop() {
  if (!chatId) return;
  try { await post(`/chats/${chatId}/abort`); } catch { /* ignore */ }
  setBusy(false);
  endStream();
}

export const currentChat = () => chatId;
export const isBusy = () => busyState;
export { esc };
