// Server-Sent Events hub: one stream per browser tab, broadcast to all.
const clients = new Set();
const history = [];
const HISTORY_LIMIT = 300;

export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20000);
  res.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function emit(type, data = {}) {
  const evt = { type, ts: Date.now(), ...data };
  if (!type.endsWith('.delta')) {
    history.push(evt);
    if (history.length > HISTORY_LIMIT) history.shift();
  }
  const payload = `event: message\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
  return evt;
}

export const clientCount = () => clients.size;
