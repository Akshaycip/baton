// The ordinary life of a Baton, against the staking pool code deployed on testnet.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { near } from '../tools/localnet/chain.mjs';
import { ALICE, BOB, CAROL, COLLECTION, ONE_YOCTO, POOL, baton, collect, list, mint, setup, yocto } from './harness.mjs';

const close = (actual, expected, tolerance = near('0.001')) => {
  const diff = BigInt(actual) - BigInt(expected);
  assert.ok((diff < 0n ? -diff : diff) <= tolerance, `${actual} is not close to ${expected}`);
};

test('minting creates a vault that really is a delegator at the pool', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 100 });
  assert.equal(id, `b1.${COLLECTION}`);
  assert.ok(chain.exists(id), 'the vault is a real account');

  const held = chain.view(POOL, 'get_account', { account_id: id });
  close(held.staked_balance, near(100));
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, ALICE);

  const view = baton(chain, id);
  assert.equal(view.status, 'Staked');
  assert.equal(view.baton.lock, null);
  close(view.baton.staked, near(100));
  assert.equal(view.baton.deposited, yocto(near(100)));
});

test('a mint can be a gift: the receiver is the holder from the start', () => {
  const { chain } = setup();
  const id = mint(chain, { from: ALICE, receiver_id: CAROL, amount: 10 });
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, CAROL);
  assert.equal(chain.view(`${id}`, 'nft_item_info', {}).owner_id, CAROL);
});

test('rewards from the validator show up as earned after a sync, and the art updates', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 100 });
  const before = chain.view(COLLECTION, 'nft_token', { token_id: id }).metadata;

  chain.advanceEpoch({ [POOL]: near(50) });
  assert.ok(chain.call(CAROL, POOL, 'ping', {}).ok);
  assert.equal(chain.call(CAROL, COLLECTION, 'baton_sync', { token_id: id }).value, true);

  const view = baton(chain, id);
  assert.ok(BigInt(view.baton.earned) > 0n, 'position earned something');
  // The pool's share of rewards: 100 of 1100 NEAR staked, minus the 10% validator fee.
  close(view.baton.earned, (near(50) * 90n * 100n) / (100n * 1100n), near('0.05'));

  const after = chain.view(COLLECTION, 'nft_token', { token_id: id }).metadata;
  assert.notEqual(before.media, after.media, 'the picture is drawn from live state');
  assert.match(after.media, /^data:image\/svg\+xml;base64,/);
  const extra = JSON.parse(after.extra);
  assert.equal(extra.earned, view.baton.earned);
  assert.equal(extra.status, 'Staked');
});

test('unstake, wait four epochs, withdraw and claim: NEAR reaches the holder', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });

  assert.equal(collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: null }).value, true);
  let view = baton(chain, id);
  assert.equal(view.status, 'Unbonding');
  assert.equal(view.epochs_left, '4');
  close(view.baton.unstaked, near(40));

  // Too early: the pool itself refuses and nothing moves.
  const early = collect(chain, ALICE, 'baton_withdraw', { token_id: id });
  assert.equal(early.value, false);
  assert.equal(baton(chain, id).baton.lock, null, 'a refused withdrawal releases the lock');

  for (let i = 0; i < 4; i++) chain.advanceEpoch();
  assert.equal(chain.call(CAROL, COLLECTION, 'baton_sync', { token_id: id }).value, true);
  assert.equal(baton(chain, id).status, 'Ready to withdraw');

  assert.equal(collect(chain, ALICE, 'baton_withdraw', { token_id: id }).value, true);
  view = baton(chain, id);
  assert.equal(view.status, 'Ready to claim');

  const before = chain.balance(ALICE);
  const claim = collect(chain, ALICE, 'baton_claim', { token_id: id, amount: null });
  assert.ok(BigInt(claim.value) > near('39.9'));
  close(chain.balance(ALICE) - before + ONE_YOCTO, near(40));

  view = baton(chain, id);
  assert.equal(view.baton.paid_out, claim.value);
  assert.equal(view.status, 'Empty');
});

test('a few yoctoNEAR of pool rounding do not change what a position is', () => {
  const { chain } = setup();
  chain.advanceEpoch({ [POOL]: near(37) });
  chain.call(CAROL, POOL, 'ping', {});
  const id = mint(chain, { amount: 7 });
  const held = chain.view(POOL, 'get_account', { account_id: id });
  assert.ok(BigInt(held.unstaked_balance) > 0n && BigInt(held.unstaked_balance) < near('0.001'), `expected rounding dust, got ${held.unstaked_balance}`);
  const view = baton(chain, id);
  assert.equal(view.status, 'Staked');
  assert.equal(view.epochs_left, '4');
  assert.equal(view.baton.unlock_epoch, '0');
});

test('a holder can add to the stake and the books keep up', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 10 });
  const result = chain.call(ALICE, COLLECTION, 'baton_stake', { token_id: id }, { deposit: near(5) });
  assert.equal(result.value, true);
  const view = baton(chain, id);
  assert.equal(view.baton.deposited, yocto(near(15)));
  close(view.baton.staked, near(15));
  assert.equal(view.baton.earned, '0');
});

test('selling the NFT passes the live stake to the buyer with no unstaking', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 100 });
  const stakedBefore = chain.view(POOL, 'get_total_staked_balance', {});
  const listing = list(chain, id, 95);

  const sale = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(95) });
  assert.ok(sale.ok, JSON.stringify(sale.failures));

  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, BOB);
  assert.equal(chain.view(POOL, 'get_total_staked_balance', {}), stakedBefore, 'the validator never lost stake');
  close(chain.view(POOL, 'get_account', { account_id: id }).staked_balance, near(100));

  // The new holder can act, and the proceeds reached the seller minus the 0.1% fee.
  const unstake = collect(chain, BOB, 'baton_unstake', { token_id: id, amount: null });
  assert.equal(unstake.value, true);
});

test('NEAR that is mid-unbonding can be sold, and the buyer collects it at the end', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 50 });
  collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: null });
  chain.advanceEpoch();

  const listing = list(chain, id, 49.5);
  assert.equal(listing.unlock_epoch, baton(chain, id).baton.unlock_epoch);
  const sale = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(49.5) });
  assert.ok(sale.ok);

  for (let i = 0; i < 3; i++) chain.advanceEpoch();
  assert.equal(collect(chain, BOB, 'baton_withdraw', { token_id: id }).value, true);
  const before = chain.balance(BOB);
  collect(chain, BOB, 'baton_claim', { token_id: id, amount: null });
  close(chain.balance(BOB) - before, near(50));
});

test('C7 history records earned, paid and holders', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 100 });
  chain.advanceEpoch({ [POOL]: near(50) });
  chain.call(CAROL, POOL, 'ping', {});
  const listing = list(chain, id, 90);
  const earnedAtSale = baton(chain, id).baton.earned;
  chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(90) });

  chain.advanceEpoch({ [POOL]: near(50) });
  chain.call(CAROL, POOL, 'ping', {});
  chain.call(CAROL, COLLECTION, 'baton_sync', { token_id: id });
  chain.call(BOB, COLLECTION, 'nft_transfer', { receiver_id: CAROL, token_id: id }, { deposit: ONE_YOCTO });

  const { legs, log, legs_total, earned } = baton(chain, id).baton;
  assert.deepEqual(legs.map((leg) => leg.holder), [ALICE, BOB, CAROL]);
  assert.equal(legs_total, 3);
  assert.equal(legs[1].price, yocto(near(90)), 'the price paid is on the record');
  assert.equal(legs[1].earned_at_start, earnedAtSale);
  assert.ok(BigInt(earned) > BigInt(earnedAtSale), 'it kept earning for the next holder');
  assert.deepEqual(log.map((entry) => entry.kind), ['Minted', 'Staked', 'Listed', 'Sold', 'Transferred']);

  const sold = log.find((entry) => entry.kind === 'Sold');
  assert.equal(sold.amount, yocto(near(90)));
  assert.equal(sold.who, BOB);
});
