// The full path on real testnet: a real validator's pool, real receipts, real gas.
//   node scripts/testnet-e2e.mjs [mint|finish]
//
// `mint` runs everything up to unstaking. The staking pool then holds the NEAR for 4 epochs, about
// 29 hours, and `finish` collects it. The transactions and gas burnt go to deployments/e2e.json.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { accountInfo, call, view } from '../server/testnet.mjs';

const { collection: COLLECTION, pools } = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const MAYA = process.env.BATON_MAYA ?? 'baton-maya.testnet';
const SAM = process.env.BATON_SAM ?? 'baton-sam.testnet';
const POOL = process.env.BATON_POOL ?? pools[0];
const REPORT = 'deployments/e2e.json';
const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : { steps: [] };
const near = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 24n) / 1_000_000n;
const ONE_YOCTO = 1n;

function record(name, result) {
  const entry = { name, tx: result.hash, tgas_burnt: Math.round(result.gasBurnt / 1e12), failures: result.failures, value: result.value };
  report.steps.push(entry);
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${name}: ${result.hash} (${entry.tgas_burnt} TGas burnt)${result.failures.length ? ` FAILURES ${JSON.stringify(result.failures)}` : ''}`);
  return result;
}

const act = (signer, method, args, options = { deposit: ONE_YOCTO }) => call(signer, COLLECTION, method, args, options);
const baton = (id) => view(COLLECTION, 'baton_get', { token_id: id });

if ((process.argv[2] ?? 'mint') === 'mint') {
  const minted = record('mint', await act(MAYA, 'baton_mint', { pool: POOL }, { deposit: near(2.06) }));
  assert.equal(minted.value, true, 'mint');
  const id = minted.events.find((e) => e.event === 'nft_mint').data[0].token_ids[0];
  report.token = id;
  console.log('Baton', id);

  const vault = await accountInfo(id);
  assert.equal(vault.keys, 0, 'vault has no keys');
  const staked = await view(POOL, 'get_account', { account_id: id });
  console.log('Pool says', staked);
  assert.ok(BigInt(staked.staked_balance) > near(1.99), 'the validator holds the stake');
  const item = await view(id, 'nft_item_info');
  assert.equal(item.owner_id, MAYA);

  record('list', await act(MAYA, 'baton_list', { token_id: id, price: near(1.99).toString() }));
  const { listing } = await baton(id);
  assert.ok(listing, 'listing opened');
  const stakeBefore = await view(POOL, 'get_total_staked_balance');
  const bought = record('buy', await act(SAM, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: BigInt(listing.price) }));
  assert.ok(bought.ok, 'sale');
  assert.equal((await view(COLLECTION, 'nft_token', { token_id: id })).owner_id, SAM);
  console.log('Validator stake before and after the sale:', stakeBefore, await view(POOL, 'get_total_staked_balance'));

  const refused = record('old holder refused', await act(MAYA, 'baton_unstake', { token_id: id, amount: null }));
  assert.ok(!refused.ok && /current holder/.test(JSON.stringify(refused)), 'the seller is out');

  const bid = record('place offer', await act(MAYA, 'baton_bid', { discount_bps: 30, max_epochs: 4 }, { deposit: near(2.505) }));
  record('sell into offer', await act(SAM, 'baton_fill', { token_id: id, bid_id: bid.value, min_price: '0' }));
  assert.equal((await view(COLLECTION, 'nft_token', { token_id: id })).owner_id, MAYA, 'instant exit moved the title');

  // A real rollback: the receiver has no contract, so the token must come back on its own.
  const bounced = record('transfer-call to an account with no contract', await act(MAYA, 'nft_transfer_call', { receiver_id: SAM, token_id: id, msg: '' }));
  assert.equal(bounced.value, false, 'transfer-call reported that the token came back');
  assert.equal((await view(COLLECTION, 'nft_token', { token_id: id })).owner_id, MAYA, 'token returned to the sender');
  assert.equal((await baton(id)).baton.lock, null, 'lock released after the rollback');

  record('unstake', await act(MAYA, 'baton_unstake', { token_id: id, amount: null }));
  const view1 = await baton(id);
  console.log('Status', view1.status, 'epochs left', view1.epochs_left, 'unlock epoch', view1.baton.unlock_epoch);
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.log('Run `node scripts/testnet-e2e.mjs finish` after 4 epochs, up to 28 hours.');
} else {
  const id = report.token;
  await call(MAYA, COLLECTION, 'baton_sync', { token_id: id });
  record('withdraw', await act(MAYA, 'baton_withdraw', { token_id: id }));
  const claimed = record('claim', await act(MAYA, 'baton_claim', { token_id: id, amount: null }));
  console.log('Claimed', claimed.value);
  console.log(await baton(id));
}
