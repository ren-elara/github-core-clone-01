import { createApp } from './app.ts';
const env = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!env) process.exit(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const server = createApp();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no port');
  for (let attempt = 0; ; attempt++) { try { const r = await fetch(`${env}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: address.port }) }); if (r.status === 200 || r.status === 409) break; } catch {} await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8))); }
  for (let attempt = 0; ; attempt++) { try { const r = await fetch(`${env}/done`); if ((await r.json()).done === true) break; } catch {} await sleep(Math.min(2000, 250 * 2 ** Math.min(attempt, 8))); }
  server.close();
}
main().then(() => process.exit(0), () => process.exit(1));
