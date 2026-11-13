// Checks the live testnet deployment against this repository. Read-only: it needs no keys and sends
// no transactions. Exits non-zero if anything does not hold.
//
//   npm run verify:testnet
//   npm run verify:testnet -- b1.baton-relay.testnet     to check a particular Baton

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { base58encode } from '../tools/localnet/chain.mjs';

const RPCS = (process.env.NEAR_RPC_URLS ?? 'https://test.rpc.fastnear.com,https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org').split(',');
const { collection, vault_code_hash: vaultHash, pool_suffix: suffix } = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const film = JSON.parse(readFileSync('deployments/film.json', 'utf8'));
const TOKEN = process.argv[2] ?? film.token;
const FACTORY = suffix.slice(1);
const near = (y) => (Number(BigInt(y) / 10n ** 21n) / 1000).toFixed(3);
const hashOf = (path) => base58encode(createHash('sha256').update(readFileSync(path)).digest());

async function rpc(method, params) {
  let failure;
  for (const url of RPCS) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'baton', method, params }) });
      const data = await response.json();
      if (data.error) throw new Error(JSON.stringify(data.error).slice(0, 200));
      return data.result;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

const at = (block) => (block ? { block_id: block } : { finality: 'final' });
const keysOf = async (id) => (await rpc('query', { request_type: 'view_access_key_list', account_id: id, ...at() })).keys.length;
const accountOf = (id) => rpc('query', { request_type: 'view_account', account_id: id, ...at() });
async function view(account, method, args = {}, block) {
  const result = await rpc('query', { request_type: 'call_function', account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), ...at(block) });
  if (result.error) throw new Error(result.error);
  return JSON.parse(Buffer.from(result.result).toString());
}

let passed = 0;
function check(label, fn, detail) {
  fn();
  passed += 1;
  console.log(`ok  ${label}${detail ? `\n      ${detail}` : ''}`);
}

console.log(`Collection ${collection}, Baton ${TOKEN}\n`);

const collectionKeys = await keysOf(collection);
check('The collection has no access keys, so nobody can change it', () => assert.equal(collectionKeys, 0), `keys: ${collectionKeys}`);

const liveCollection = await accountOf(collection);
const builtCollection = hashOf('res/baton_collection.wasm');
check('The collection runs exactly the code in res/', () => assert.equal(liveCollection.code_hash, builtCollection), liveCollection.code_hash);

const builtVault = hashOf('res/baton_vault.wasm');
check('The published vault code is the build in res/', () => assert.equal(vaultHash, builtVault), builtVault);

const vaultKeys = await keysOf(TOKEN);
check('The vault has no access keys, so nobody can sign for it', () => assert.equal(vaultKeys, 0), `keys: ${vaultKeys}`);

const vault = await accountOf(TOKEN);
const vaultCode = vault.global_contract_hash ?? vault.code_hash;
check('The vault runs the published code, fixed by its hash', () => assert.equal(vaultCode, vaultHash), vaultCode);

const info = await view(TOKEN, 'vault_info');
check('The vault belongs to this collection', () => assert.equal(info.collection_id, collection));

const label = info.pool_id.endsWith(suffix) ? info.pool_id.slice(0, -suffix.length) : null;
check('Its validator is a sub-account of the official pool factory', () => assert.ok(label && !label.includes('.')), info.pool_id);

const factoryKeys = await keysOf(FACTORY);
check('That factory has no access keys, so it only ever creates the official pool code', () => assert.equal(factoryKeys, 0), `${FACTORY}, keys: ${factoryKeys}`);

const position = await view(info.pool_id, 'get_account', { account_id: TOKEN });
const held = BigInt(position.staked_balance) + BigInt(position.unstaked_balance);
check("The validator's own contract holds this account's stake", () => assert.ok(held > 0n), `${near(position.staked_balance)} NEAR staked, ${near(position.unstaked_balance)} NEAR unstaking`);

const { header } = await rpc('block', { finality: 'final' });
const block = header.height;
const [item, token, baton] = await Promise.all([view(TOKEN, 'nft_item_info', {}, block), view(collection, 'nft_token', { token_id: TOKEN }, block), view(collection, 'baton_get', { token_id: TOKEN }, block)]);
check('The account and the NFT name the same holder, read at one block (Sharded Items pair check)', () => {
  assert.equal(item.spec, 'sharded-item-1.0.0');
  assert.equal(item.collection_id, collection);
  assert.equal(item.token_id, TOKEN);
  assert.equal(item.owner_id, token.owner_id);
  assert.equal(item.rotation_seq, baton.baton.rotation_seq);
}, `holder ${token.owner_id}, rotation ${item.rotation_seq}, block ${block}`);

check('The NFT carries its chain of title', () => assert.ok(baton.baton.legs.length >= 1), baton.baton.legs.map((leg) => `${leg.holder} (paid ${near(leg.price)})`).join(' -> '));
check('The NFT picture is generated on chain', () => assert.match(token.metadata.media, /^data:image\/svg\+xml;base64,/));

console.log(`\nAll ${passed} checks passed.`);
