// The whole product in one run, with no browser and no wallet. Every line is read back from the
// chain and checked, and the process exits non-zero if anything is not as described.
//
//   npm run story

import assert from 'node:assert/strict';
import { TGAS, near, toNear } from '../tools/localnet/chain.mjs';
import { COLLECTION, createLocal } from '../server/local.mjs';
import { notesFor } from '../server/notes.mjs';
import { createRoom } from '../server/room.mjs';

const MAYA = 'maya.testnet';
const SAM = 'sam.testnet';
const ONE_YOCTO = 1n;
const POOL = 'stakely_v2.pool.f863973.m0';

const say = (text) => console.log(`\n${text}`);
const fact = (text) => console.log(`   ${text}`);
const nearText = (y) => `${toNear(y).toFixed(3)} NEAR`;

const local = createLocal();
const { chain } = local;
const room = createRoom({ reader: local.reader(), notes: notesFor });
const baton = (id) => chain.view(COLLECTION, 'baton_get', { token_id: id });
const owner = (id) => chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id;

say('1. Maya stakes 50 NEAR with a validator, through a Baton.');
const minted = chain.call(MAYA, COLLECTION, 'baton_mint', { pool: POOL }, { deposit: near(50) + near('0.06'), gas: 300n * TGAS });
assert.equal(minted.value, true);
const id = minted.events.find((e) => e.event === 'nft_mint').data[0].token_ids[0];
const position = chain.view(POOL, 'get_account', { account_id: id });
fact(`The NFT ${id} is also a real account.`);
fact(`Access keys on that account: ${chain.keys(id)}`);
fact(`The validator's own contract says this account has ${nearText(position.staked_balance)} staked.`);
assert.equal(chain.keys(id), 0);
assert.ok(BigInt(position.staked_balance) >= near('49.9'));

say('2. A month passes. Rewards build up and the NFT redraws itself.');
const artBefore = chain.view(COLLECTION, 'nft_token', { token_id: id }).metadata.media;
local.skip(100);
chain.call(MAYA, COLLECTION, 'baton_sync', { token_id: id });
const artAfter = chain.view(COLLECTION, 'nft_token', { token_id: id }).metadata.media;
const earned = baton(id).baton.earned;
fact(`Earned so far: ${nearText(earned)}`);
fact(`NFT picture changed: ${artBefore !== artAfter}`);
assert.ok(BigInt(earned) > 0n);
assert.notEqual(artBefore, artAfter);

say('3. Before selling, Maya opens the holder-only room and takes an API key.');
const { nonce } = room.challenge();
const { session } = await room.enter({ tokenId: id, nonce, ...local.signMessage(MAYA, { nonce }) });
const { apiKey } = await room.issueCredential(id, `Bearer ${session}`);
await room.open(id, `Bearer ${session}`);
fact('Signature accepted. The chain confirms Maya holds it. The room opens.');

say('4. Maya needs the money today, and sells into a standing offer in one transaction.');
const [offer] = chain.view(COLLECTION, 'baton_bids', {});
const before = chain.balance(MAYA);
const stakeBefore = chain.view(POOL, 'get_total_staked_balance', {});
const filled = chain.call(MAYA, COLLECTION, 'baton_fill', { token_id: id, bid_id: offer.id, min_price: '0' }, { deposit: ONE_YOCTO });
assert.equal(filled.value, true);
const received = chain.balance(MAYA) - before + ONE_YOCTO;
fact(`Maya received ${nearText(received)} immediately.`);
fact(`Holder of the NFT is now: ${owner(id)}`);
fact(`Total staked at the validator changed by: ${toNear(BigInt(chain.view(POOL, 'get_total_staked_balance', {})) - BigInt(stakeBefore))} NEAR`);
assert.equal(owner(id), offer.bidder);
assert.equal(chain.view(POOL, 'get_total_staked_balance', {}), stakeBefore);

say('5. Maya has sold, so everything kept from before stops working.');
const refused = async (promise) => promise.then(() => 'OPENED').catch((error) => error.code);
const tried = chain.call(MAYA, COLLECTION, 'baton_unstake', { token_id: id, amount: null }, { deposit: ONE_YOCTO });
fact(`Try to unstake: ${tried.error}`);
assert.match(tried.error, /current holder/);
const sessionAttempt = await refused(room.open(id, `Bearer ${session}`));
fact(`Try the old room session: ${sessionAttempt}`);
assert.equal(sessionAttempt, 'not_the_holder');
const keyAttempt = await refused(room.rpc(apiKey, { method: 'status' }));
fact(`Try the old API key: ${keyAttempt}`);
assert.equal(keyAttempt, 'key_died_with_the_sale');

say('6. A seller cannot sneak money out during a sale. A payout blocks every transfer until it ends.');
const trap = chain.call(SAM, COLLECTION, 'baton_mint', { pool: POOL }, { deposit: near(3) + near('0.06'), gas: 300n * TGAS }).events.find((e) => e.event === 'nft_mint').data[0].token_ids[0];
chain.call(SAM, COLLECTION, 'baton_unstake', { token_id: trap, amount: null }, { deposit: ONE_YOCTO });
local.skip(4);
chain.call(SAM, COLLECTION, 'baton_withdraw', { token_id: trap }, { deposit: ONE_YOCTO });
const payout = chain.submit(SAM, COLLECTION, 'baton_claim', { token_id: trap, amount: null }, { deposit: ONE_YOCTO });
chain.step();
const sneak = chain.call(SAM, COLLECTION, 'nft_transfer', { receiver_id: MAYA, token_id: trap }, { deposit: ONE_YOCTO });
fact(`While the payout is in flight, try to transfer the NFT: ${sneak.error}`);
assert.match(sneak.error, /mid-operation/);
chain.drain();
assert.ok(chain.summary(payout).value);

say('7. Sam, the new holder, can unstake and collect the NEAR.');
chain.call(SAM, COLLECTION, 'baton_unstake', { token_id: id, amount: null }, { deposit: ONE_YOCTO });
local.skip(4);
chain.call(SAM, COLLECTION, 'baton_withdraw', { token_id: id }, { deposit: ONE_YOCTO });
const samBefore = chain.balance(SAM);
const claim = chain.call(SAM, COLLECTION, 'baton_claim', { token_id: id, amount: null }, { deposit: ONE_YOCTO });
fact(`Sam collected ${nearText(claim.value)}.`);
assert.ok(chain.balance(SAM) > samBefore);

say('8. The NFT carries its own record.');
const { legs, earned: total, paid_out: paid } = baton(id).baton;
legs.forEach((leg, index) => fact(`Holder ${index + 1}: ${leg.holder}, paid ${nearText(leg.price)}`));
fact(`Earned in its life: ${nearText(total)}. Paid out: ${nearText(paid)}.`);
assert.deepEqual(legs.map((leg) => leg.holder), [MAYA, SAM]);

console.log('\nEvery step above matched what the chain reported.');
