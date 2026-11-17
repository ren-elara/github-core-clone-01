import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';
const repos = new Map<string, any>();
const files = new Map<string, Map<string, any>>();
const issues = new Map<string, any[]>();
let nextId = 1;
const now = () => new Date().toISOString();
const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
};
const sendText = (res: ServerResponse, status: number, text: string, type: string) => {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
  res.end(text);
};
const readBody = async (req: IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString();
  try { return JSON.parse(text); } catch { return { raw: text }; }
};
const idSha = (value: string) => Buffer.from(value).toString('base64url').slice(0, 40);
const owner = (login = 'makefun') => ({ login, id: 1, type: 'User', site_admin: false });
const repoKey = (path: string) => path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
function ensureRepo(key: string): any {
  let repo = repos.get(key);
  if (repo) return repo;
  const [login, name] = key.split('/', 2);
  repo = { id: nextId++, name, full_name: key, owner: owner(login), private: false, default_branch: 'main', description: null, created_at: now(), updated_at: now(), clone_url: `http://forge/${key}.git`, html_url: `http://forge/${key}` };
  repos.set(key, repo); files.set(key, new Map()); issues.set(key, []); return repo;
}
function authorized(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url?.startsWith('/healthz')) return true;
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) { sendJson(res, 401, { message: 'Bad credentials' }); return false; }
  return true;
}
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams, body: any): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'v3') { sendJson(res, 404, { message: 'Not Found' }); return; }
  const route = parts.slice(2);
  if (!route.length) { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
  if (route[0] === 'user') { sendJson(res, 200, { ...owner(), name: 'Makefun User', email: null, public_repos: repos.size }); return; }
  if (route[0] === 'rate_limit') { sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } }, rate: { limit: 5000, remaining: 4999 } }); return; }
  if (route[0] === 'repos' && route.length === 1 && req.method === 'GET') { sendJson(res, 200, [...repos.values()]); return; }
  if (route[0] === 'user' && route[1] === 'repos' && req.method === 'GET') { sendJson(res, 200, [...repos.values()].filter((r) => r.owner.login === 'makefun')); return; }
  if (route[0] === 'user' && route[1] === 'repos' && req.method === 'POST') { const r = ensureRepo(`makefun/${body.name || 'repository'}`); r.description = body.description ?? null; sendJson(res, 201, r); return; }
  if (route.length < 2) { sendJson(res, 404, { message: 'Not Found' }); return; }
  const key = `${route[0]}/${route[1]}`; const repo = ensureRepo(key); const sub = route.slice(2);
  if (!sub.length && req.method === 'GET') { sendJson(res, 200, repo); return; }
  if (!sub.length && req.method === 'PATCH') { Object.assign(repo, body, { full_name: key, owner: owner(route[0]), updated_at: now() }); sendJson(res, 200, repo); return; }
  if (sub[0] === 'branches' && req.method === 'GET') { sendJson(res, 200, [{ name: repo.default_branch, protected: false, commit: { sha: idSha(key), url: `/api/v3/repos/${key}/commits/${idSha(key)}` } }]); return; }
  if (sub[0] === 'commits' && req.method === 'GET') { sendJson(res, 200, [{ sha: idSha(key), commit: { message: 'Initial commit', author: { name: 'makefun', email: 'noreply@localhost', date: repo.created_at }, committer: { name: 'makefun', email: 'noreply@localhost', date: repo.created_at } }, author: owner(), committer: owner() }]); return; }
  if (sub[0] === 'contents') {
    const file = sub.slice(1).join('/'); const store = files.get(key)!;
    if (req.method === 'GET') { const item = store.get(file); if (!item) { sendJson(res, 404, { message: 'Not Found' }); return; } sendJson(res, 200, { name: file.split('/').pop(), path: file, sha: item.sha, size: Buffer.byteLength(item.content), type: 'file', content: Buffer.from(item.content).toString('base64'), encoding: 'base64' }); return; }
    if (req.method === 'PUT') { const content = Buffer.from(body.content || '', body.encoding === 'base64' ? 'base64' : 'utf8').toString(); const item = { content, sha: idSha(content) }; store.set(file, item); sendJson(res, 201, { content: { path: file, sha: item.sha, type: 'file' }, commit: { sha: idSha(file + content), message: body.message || 'Update file' } }); return; }
  }
  if (sub[0] === 'issues') { const list = issues.get(key)!; if (req.method === 'GET') { const state = query.get('state') || 'open'; sendJson(res, 200, list.filter((i) => state === 'all' || i.state === state)); return; } if (req.method === 'POST') { const issue = { number: list.length + 1, id: nextId++, title: body.title || '', body: body.body ?? null, state: 'open', user: owner(), labels: body.labels || [], comments: 0, created_at: now(), updated_at: now() }; list.push(issue); sendJson(res, 201, issue); return; } }
  if (sub[0] === 'pulls' && req.method === 'GET') { sendJson(res, 200, []); return; }
  sendJson(res, 404, { message: 'Not Found' });
}
export function createApp(): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://forge').pathname;
    if (req.method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    if (!authorized(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://forge');
    if (path === '/api/graphql' && req.method === 'POST') { void readBody(req).then((input) => { const q = String(input.query || ''); const data: any = {}; if (/viewer|user\s*\(/.test(q)) data.viewer = owner(); if (/repository/.test(q)) data.repository = ensureRepo('makefun/repository'); if (/rateLimit/.test(q)) data.rateLimit = { limit: 5000, remaining: 4999, resetAt: now() }; sendJson(res, 200, { data }); }); return; }
    if (path === '/mcp' && req.method === 'POST') { void readBody(req).then((input) => { const result = input.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'makefun-forge', version: '1.0.0' } } : input.method === 'tools/list' ? { tools: [{ name: 'search_repositories', inputSchema: { type: 'object' } }, { name: 'get_file_contents', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }; sendJson(res, 200, { jsonrpc: '2.0', id: input.id ?? null, result }); }); return; }
    if (path.startsWith('/api/v3')) { void readBody(req).then((body) => handleRest(req, res, path, url.searchParams, body)); return; }
    if (path.endsWith('/info/refs')) { sendText(res, 200, '# service=git-upload-pack\n\n0000', 'application/x-git-upload-pack-advertisement'); return; }
    if (path.endsWith('/git-upload-pack') || path.endsWith('/git-receive-pack')) { sendText(res, 200, '0000', 'application/x-git-upload-pack-result'); return; }
    sendJson(res, 404, { message: 'Not Found' });
  });
}
