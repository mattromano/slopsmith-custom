// Evaluate an expression in the feedback renderer page via DevTools.
const expr = process.argv[2];
const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1|localhost/.test(t.url)) || list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id === 1) { console.log(JSON.stringify(d.result.result.value ?? d.result, null, 1)); process.exit(0); }
});
setTimeout(() => { console.log('timeout'); process.exit(1); }, Number(process.env.CDP_TIMEOUT_MS || 40000));
