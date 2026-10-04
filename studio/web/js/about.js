// About the studio: the disclaimer (shown once per installation, and from the footer) and what's new (the release
// history the version number is calculated from).
import { store, get, post } from './api.js';
import { h, modal, toast } from './ui.js';

// Raise when the disclaimer text changes, so everyone sees the new text once.
export const DISCLAIMER_VERSION = 1;

function disclaimerBody() {
  const li = (...kids) => h('li', {}, ...kids);
  return h('div', { class: 'disc' },
    h('p', { style: { margin: 0 } }, h('b', {}, 'Fabric MCP Studio is a sample app'), ', created by Luis Fernando Borbon for demos, learning and proofs of concept.'),
    h('h3', {}, 'Not a Microsoft product'),
    h('ul', {},
      li('It isn\'t an official Microsoft product or service, isn\'t supported by Microsoft Support and isn\'t covered by any Microsoft service-level agreement.'),
      li('It\'s provided ', h('b', {}, 'as is, without warranty of any kind'), ', express or implied. Try it in a test workspace before using it with production workspaces or data.'),
      li('Questions and feedback: ', h('a', { href: 'mailto:luisbor@microsoft.com' }, 'luisbor@microsoft.com'), ' – best effort, no support commitment.')),
    h('h3', {}, 'What it does in your tenant'),
    h('ul', {},
      li('It runs on your computer and acts in Microsoft Fabric and Power BI with ', h('b', {}, 'your own sign-in and permissions'), '. It asks before every change.'),
      li('What it creates – workspaces, lakehouses, databases, semantic models, ontologies, reports, notebooks, plans, alerts and agents – lives in your tenant, runs on your Fabric capacity and may incur costs. You\'re responsible for reviewing, securing, sharing and removing it.'),
      li('AI suggestions – model designs, measures, instructions, answers – can be incomplete or wrong. Review them before you apply them or rely on them.'),
      li('Your data stays in your tenant. Prompts, and data included in answers, go to the AI provider you choose (for example Azure AI Foundry / Azure OpenAI) under that provider\'s terms.'),
      li('Some features use Microsoft Fabric preview capabilities (for example ontologies, planning, data agents and the Power BI MCP endpoints). Previews are subject to their preview terms and can change or stop working.')),
    h('h3', {}, 'Sharing this app'),
    h('ul', {},
      li(h('b', {}, 'Inside Microsoft: '), 'share it as a sample and keep this disclaimer. Don\'t present it as a supported Microsoft offering or a commitment, and follow Microsoft\'s guidance for sharing code and demos with customers.'),
      li(h('b', {}, 'With customers and partners: '), 'it\'s sample code, not a Microsoft product. Review it with your security and compliance teams, and install it only in tenants and workspaces you\'re allowed to change. Microsoft Fabric, Power BI and Copilot are used under your own licenses and agreements.')));
}

/** The full disclaimer. With requireAck it can't be dismissed until it's acknowledged (first run). */
export function showDisclaimer({ requireAck = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title: 'Disclaimer', className: requireAck ? 'appr wide' : 'wide', body: disclaimerBody(),
      onClose: () => resolve(!requireAck),
      actions: requireAck
        ? [{ label: 'I understand', class: 'pri', onClick: async () => { try { store.settings = await post('/disclaimer/accept', { version: DISCLAIMER_VERSION }); } catch (e) { toast(e.message, 'err'); } resolve(true); return true; } }]
        : [{ label: 'Close', class: 'pri' }],
    });
  });
}

/** Show the disclaimer once per installation (and again when its text changes). */
export async function ensureDisclaimer() {
  if ((store.settings?.disclaimer?.version || 0) >= DISCLAIMER_VERSION) return;
  await showDisclaimer({ requireAck: true });
}

/** What's new: every improvement and fix, newest first, with the version each one brought. */
export async function showWhatsNew() {
  let a;
  try { a = await get('/about'); } catch (e) { toast(e.message, 'err'); return; }
  const pill = (t) => h('span', { class: `pill ${t === 'fix' ? 'warn' : t === 'release' ? 'brand' : 'ok'}` }, t === 'fix' ? 'Fix' : t === 'release' ? 'Release' : 'Improvement');
  const list = h('div', { class: 'relnotes' }, a.changes.map((c) => h('div', { class: 'rel' }, h('b', { class: 'mono' }, `v${c.version}`), pill(c.type), h('span', {}, c.title, h('span', { class: 'tiny muted' }, `  ${c.date}${c.commit ? ` · ${c.commit}` : ''}`)))));
  modal({
    title: `What's new · v${a.version}`, className: 'wide',
    body: h('div', {},
      h('p', { class: 'small', style: { marginTop: 0 } }, `Version 1.${a.improvements}.${a.fixes}: ${a.improvements} improvements and ${a.fixes} fixes since the first release${a.build ? ` · build ${a.build.commit} (${a.build.date})` : ''}.`),
      list),
    actions: [{ label: 'Disclaimer', onClick: () => { setTimeout(() => showDisclaimer(), 0); return true; } }, { label: 'Close', class: 'pri' }],
  });
}
