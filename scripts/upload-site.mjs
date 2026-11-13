// Publishes the built app to FastFS, one testnet transaction per file. Adapted from the author's
// own earlier tooling.
//
//   npx vite build app
//   node scripts/upload-site.mjs
//
// A file already served with the same bytes is skipped. The page goes last, so the live site never
// points at an asset that has not arrived yet. The transaction is meant to fail with "Exceeded the
// prepaid gas": it carries 1 gas because nothing needs to run. The indexer reads the transaction's
// arguments.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { RPCS, accountOf, actions } from '../server/testnet.mjs';

const DIST = 'app/dist';
const { collection, pools } = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const SENDER = process.env.BATON_SITE_SENDER ?? 'baton-maya.testnet';
const RECEIVER = collection;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};
const MAX_PAYLOAD = 1_400_000;

writeFileSync(join(DIST, 'config.json'), JSON.stringify({ mode: 'testnet', signer: 'wallet', network: 'testnet', collection, rpc: RPCS, pools, personas: [] }));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const urlOf = (path) => `https://test.fastfs.io/${SENDER}/${RECEIVER}/${path}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const u32 = (n) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(n);
  return buffer;
};
const string = (text) => Buffer.concat([u32(Buffer.byteLength(text)), Buffer.from(text)]);

async function upload(path, mime, content) {
  const payload = Buffer.concat([Buffer.from([0]), string(path), Buffer.from([1]), string(mime), u32(content.length), content]);
  if (payload.length > MAX_PAYLOAD) throw new Error(`${path} is too large for one transaction`);
  try {
    const tx = await accountOf(SENDER).signAndSendTransaction({
      receiverId: RECEIVER,
      actions: [actions.functionCall('__fastdata_fastfs', payload, 1n, 0n)],
      waitUntil: 'INCLUDED_FINAL',
      throwOnFailure: false,
    });
    return tx.transaction?.hash ?? tx.transaction_outcome?.id;
  } catch (error) {
    const message = String(error.message ?? error);
    if (!/prepaid gas/i.test(message)) throw error;
    return `finished with ${message.slice(0, 120)}`;
  }
}

async function served(path) {
  const response = await fetch(urlOf(path)).catch(() => null);
  return response?.ok ? sha256(Buffer.from(await response.arrayBuffer())) : null;
}

/** Stops the whole run if a file never arrives, so the page is not pointed at a missing asset. */
async function deliver(path, mime, content, hash) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let tx;
    try {
      tx = await upload(path, mime, content);
    } catch (error) {
      console.log(`${path}: try ${attempt} was not sent: ${String(error.message).slice(0, 90)}`);
      await pause(30_000);
      continue;
    }
    await pause(15_000); // the host briefly remembers a 404, so asking too early delays the file
    for (let i = 0; i < 12; i += 1) {
      if ((await served(path)) === hash) return tx;
      await pause(12_000);
    }
  }
  throw new Error(`${path} did not arrive, so the page was left as it was`);
}

const files = readdirSync(DIST, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(DIST, join(entry.parentPath, entry.name)).split(sep).join('/'))
  .sort((a, b) => Number(a === 'index.html') - Number(b === 'index.html'));

for (const path of files) {
  const content = readFileSync(join(DIST, path));
  const hash = sha256(content);
  if ((await served(path)) === hash) {
    console.log(`${path}: already there`);
    continue;
  }
  const mime = MIME[extname(path)];
  if (!mime) throw new Error(`No media type for ${path}`);
  console.log(`${path}: ${content.length} bytes, served, ${await deliver(path, mime, content, hash)}`);
}

console.log(`\n${urlOf('index.html')}`);
