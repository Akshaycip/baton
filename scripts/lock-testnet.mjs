// Removes every access key from the collection account, so its code and rules can never change.
// This cannot be undone. A fix after this needs a new account and a new deployment.
//   node scripts/lock-testnet.mjs
//
// Refuses to run unless the code on chain is byte-identical to res/baton_collection.wasm.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { base58encode } from '../tools/localnet/chain.mjs';
import { accountInfo, accountOf, provider } from '../server/testnet.mjs';

const { collection } = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const built = base58encode(createHash('sha256').update(readFileSync('res/baton_collection.wasm')).digest());
const live = (await accountInfo(collection)).codeHash;
if (built !== live) throw new Error(`On-chain code ${live} is not this build ${built}. Deploy it first.`);
console.log(`On-chain code matches this build: ${live}`);

const { keys } = await provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: collection });
if (keys.length === 0) {
  console.log(`${collection} already has no keys.`);
  process.exit(0);
}

const me = accountOf(collection);
for (const { public_key: key } of keys) {
  await me.deleteKey(key);
  console.log(`Removed ${key}`);
}
console.log(`${collection} now has ${(await accountInfo(collection)).keys} access keys.`);
