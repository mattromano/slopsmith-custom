const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } }));
ws.addEventListener('message', (m) => { if (JSON.parse(m.data).id === 1) { console.log('reloaded'); process.exit(0); } });
