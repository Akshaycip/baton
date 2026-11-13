// Publishes the vault code and deploys the collection to testnet.
//   node scripts/deploy-testnet.mjs            publish the vault and deploy the collection
//   node scripts/deploy-testnet.mjs code-only  replace the collection's code, keeping its state
//
// Signs with keys already in ~/.near-credentials, and only for accounts named baton-*.testnet.
// BATON_COLLECTION picks the account (default baton-relay.testnet).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { base58encode } from '../tools/localnet/chain.mjs';
import { accountInfo, accountOf, actions, outcomeOf } from '../server/testnet.mjs';

const COLLECTION = process.env.BATON_COLLECTION ?? 'baton-relay.testnet';
const POOL_SUFFIX = '.pool.f863973.m0';
const FEE_BPS = 10;
const POOLS = ['stakely_v2', 'ts', 'aurora', '01node'].map((name) => `${name}${POOL_SUFFIX}`);

const vault = readFileSync('res/baton_vault.wasm');
const collection = readFileSync('res/baton_collection.wasm');
const hash = base58encode(createHash('sha256').update(vault).digest());
const me = accountOf(COLLECTION);

const info = await accountInfo(COLLECTION);
console.log(`Deploying from ${COLLECTION}, balance ${info.balance} yoctoNEAR`);

if (process.argv[2] === 'code-only') {
  if (info.keys === 0) throw new Error('This collection has no keys left, so its code can never be replaced.');
  const replaced = outcomeOf(await me.signAndSendTransaction({ receiverId: COLLECTION, actions: [actions.deployContract(collection)], waitUntil: 'FINAL', throwOnFailure: false }));
  if (!replaced.ok) throw new Error(JSON.stringify(replaced));
  console.log('  replaced collection code', replaced.hash);
  process.exit(0);
}

console.log(`Publishing vault code ${hash} (${vault.length} bytes)...`);
try {
  const result = outcomeOf(await me.deployGlobalContract(vault, 'codeHash'));
  console.log('  published', result.hash);
} catch (error) {
  console.log('  publish reported:', String(error.message ?? error).slice(0, 300));
}

console.log(`Deploying collection (${collection.length} bytes) and initialising it in one transaction...`);
const tx = await me.signAndSendTransaction({
  receiverId: COLLECTION,
  actions: [
    actions.deployContract(collection),
    actions.functionCall('new', { vault_code_hash: hash, pool_suffix: POOL_SUFFIX, fee_bps: FEE_BPS, treasury: COLLECTION }, 100n * 10n ** 12n, 0n),
  ],
  waitUntil: 'FINAL',
  throwOnFailure: false,
});
const result = outcomeOf(tx);
if (!result.ok || result.failures.length) throw new Error(`Deploy failed: ${JSON.stringify(result.failures)} ${result.error}`);
console.log('  deployed', result.hash);

mkdirSync('deployments', { recursive: true });
writeFileSync('deployments/testnet.json', `${JSON.stringify({ collection: COLLECTION, vault_code_hash: hash, pool_suffix: POOL_SUFFIX, fee_bps: FEE_BPS, pools: POOLS, deployed_at: new Date().toISOString(), deploy_tx: result.hash }, null, 2)}\n`);
console.log('Wrote deployments/testnet.json');
