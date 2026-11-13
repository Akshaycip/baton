// Serves the app and the holder room.
//   node server/index.mjs            a private practice chain in this process (default)
//   node server/index.mjs --testnet  real testnet, using deployments/testnet.json
//
// Set BATON_DEV_SIGNERS=a.testnet,b.testnet with --testnet to act as those accounts without a
// wallet popup. That exists for recording a demo. The transactions are real.

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notesFor } from './notes.mjs';
import { Refused, createRoom } from './room.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATIC = join(ROOT, 'app', 'dist');
const PORT = Number(process.env.PORT ?? 8787);
const TESTNET = process.argv.includes('--testnet');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json' };

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

async function backend() {
  if (!TESTNET) {
    const { createLocal, COLLECTION, PERSONAS, POOL_IDS } = await import('./local.mjs');
    const local = createLocal();
    return {
      config: { mode: 'local', signer: 'server', collection: COLLECTION, personas: PERSONAS, network: 'local', pools: POOL_IDS },
      reader: local.reader(),
      view: async ({ account, method, args }) => local.chain.view(account, method, args),
      account: async ({ id }) => {
        const acct = local.chain.get(id);
        return acct ? { exists: true, balance: acct.balance, locked: acct.locked, keys: acct.keys, codeHash: acct.codeHash } : { exists: false };
      },
      call: async ({ persona, receiver, method, args, deposit, gas }) => ({
        hash: null,
        ...local.chain.call(persona, receiver, method, args, { deposit: BigInt(deposit ?? 0), gas: BigInt(gas ?? 300_000_000_000_000n) }),
      }),
      sign: async ({ persona, nonce }) => local.signMessage(persona, { nonce }),
      time: {
        skip: async ({ epochs }) => (local.skip(Number(epochs)), { epoch: local.chain.epoch }),
        reset: async () => (local.reset(), { ok: true }),
      },
    };
  }

  const deployment = JSON.parse(readFileSync(join(ROOT, 'deployments', 'testnet.json'), 'utf8'));
  const net = await import('./testnet.mjs');
  const signers = (process.env.BATON_DEV_SIGNERS ?? '').split(',').filter(Boolean);
  const names = ['Maya', 'Sam', 'Ren'];
  return {
    config: {
      mode: 'testnet',
      signer: signers.length ? 'server' : 'wallet',
      network: 'testnet',
      collection: deployment.collection,
      rpc: net.RPCS,
      pools: deployment.pools,
      personas: signers.map((id, index) => ({ id, name: names[index] ?? id, blurb: 'Demo account on testnet' })),
    },
    reader: net.testnetReader(deployment.collection),
    view: ({ account, method, args }) => net.view(account, method, args),
    account: ({ id }) => net.accountInfo(id),
    call: ({ persona, receiver, method, args, deposit, gas }) => {
      if (!signers.includes(persona)) throw new Error('That account is not a demo signer');
      return net.call(persona, receiver, method, args, { deposit: BigInt(deposit ?? 0), gas: BigInt(gas ?? 300_000_000_000_000n) });
    },
    sign: async ({ persona, nonce }) => {
      if (!signers.includes(persona)) throw new Error('That account is not a demo signer');
      const { signNep413 } = await import('./sign.mjs');
      return signNep413(net.secretKeyOf(persona), persona, nonce);
    },
    time: null,
  };
}

const app = await backend();
const room = createRoom({ reader: app.reader, notes: notesFor });

function staticFile(res, url) {
  if (!existsSync(STATIC)) return send(res, 503, { error: 'App not built yet. Run: npm run build:app' });
  const path = normalize(join(STATIC, url === '/' ? 'index.html' : url.split('?')[0]));
  if (!path.startsWith(STATIC) || !existsSync(path) || extname(path) === '') return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream', 'cache-control': extname(path) === '.html' ? 'no-store' : 'public, max-age=3600' });
  res.end(readFileSync(path));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method === 'GET' && pathname === '/config.json') return send(res, 200, app.config);

    if (req.method === 'POST' && pathname.startsWith('/local/')) {
      const body = await readJson(req);
      if (pathname === '/local/view') return send(res, 200, { value: await app.view(body) });
      if (pathname === '/local/account') return send(res, 200, await app.account(body));
      if (pathname === '/local/call') return send(res, 200, await app.call(body));
      if (pathname === '/local/sign') return send(res, 200, await app.sign(body));
      if (pathname === '/local/skip' && app.time) return send(res, 200, await app.time.skip(body));
      if (pathname === '/local/reset' && app.time) return send(res, 200, await app.time.reset());
      return send(res, 404, { error: 'Not found' });
    }

    if (pathname === '/api/room/challenge' && req.method === 'POST') return send(res, 200, room.challenge());
    if (pathname === '/api/room/enter' && req.method === 'POST') return send(res, 200, await room.enter(await readJson(req)));
    const roomPath = /^\/api\/room\/([a-z0-9._-]+)(\/credential)?$/.exec(pathname);
    if (roomPath) {
      const [, tokenId, credential] = roomPath;
      if (credential && req.method === 'POST') return send(res, 200, await room.issueCredential(tokenId, req.headers.authorization));
      if (!credential && req.method === 'GET') return send(res, 200, await room.open(tokenId, req.headers.authorization));
    }
    const rpcPath = /^\/rpc\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (rpcPath && req.method === 'POST') return send(res, 200, await room.rpc(rpcPath[1], await readJson(req)));

    if (req.method === 'GET') return staticFile(res, pathname);
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (error instanceof Refused) return send(res, error.status, { error: error.code, ...error.detail });
    console.error(error);
    return send(res, 500, { error: String(error.message ?? error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Baton is running on http://localhost:${PORT} (${app.config.mode})`);
});
