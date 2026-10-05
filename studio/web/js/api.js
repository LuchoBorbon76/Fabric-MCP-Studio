// API client, server-sent events and a tiny reactive store.
const TOKEN = document.querySelector('meta[name="studio-token"]').content;

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-studio-token': TOKEN, ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: raw || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && data?.error === 'Unauthorized') { staleSession(); }
    // The pages are newer than the server (updated on disk while it runs): it doesn't know this request yet.
    const noRoute = res.status === 404 && data?.error === 'Not found' && (data.code === 'NO_ROUTE' || data.code == null);
    if (noRoute) fire('update.needed', {});
    const err = new Error(noRoute ? 'This part of Fabric MCP Studio was updated and needs a restart. Use "Restart now" at the top of the page (or shut down and start the studio again).' : data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status; err.code = noRoute ? 'RESTART_NEEDED' : data?.code;
    throw err;
  }
  return data;
}

// The server issues a new token on every start; an old tab must reload to pick it up.
let reloading = false;
function staleSession() {
  if (reloading) return;
  reloading = true;
  setTimeout(() => location.reload(), 300);
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });
/** Send a file's bytes as they are (for uploads). */
export const upload = (p, file) => api(p, { method: 'POST', raw: file });

// ---- store ----
const listeners = new Map();
export const store = {
  user: null, settings: null, provider: null, providers: [], project: null, catalog: null,
  jobs: new Map(), chats: [], activeChat: null, approvals: [], health: null, preset: null, platform: '',
};

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}

export function fire(evt, data) {
  for (const fn of listeners.get(evt) || []) { try { fn(data); } catch (e) { console.error(evt, e); } }
  for (const fn of listeners.get('*') || []) { try { fn(evt, data); } catch (e) { console.error(e); } }
}

// ---- SSE ----
let es = null;
export function connectEvents() {
  if (es) es.close();
  es = new EventSource(`/api/events?t=${encodeURIComponent(TOKEN)}`);
  es.addEventListener('message', (m) => {
    let e;
    try { e = JSON.parse(m.data); } catch { return; }
    if (e.type === 'job') store.jobs.set(e.job.id, e.job);
    if (e.type === 'project.updated') store.project = e.project;
    fire(e.type, e);
  });
  es.onerror = () => {
    fire('sse.error', {});
    fetch('/api/settings', { headers: { 'x-studio-token': TOKEN } })
      .then((r) => { if (r.status === 401) staleSession(); })
      .catch(() => fire('server.down', {}));
  };
  es.onopen = () => { fire('sse.open', {}); fire('server.up', {}); };
}
