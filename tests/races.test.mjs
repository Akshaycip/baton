// Sections B, C and E of the threat model. NEAR calls take several receipts, so these tests stop
// the chain between receipts and land a second transaction exactly where an attacker would.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Panic, near } from '../tools/localnet/chain.mjs';
import { ALICE, BOB, CAROL, COLLECTION, MALLORY, ONE_YOCTO, POOL, baton, collect, flakyPool, list, mint, queued, runUntil, setup, yocto } from './harness.mjs';

/** A Baton holding `amount` liquid NEAR in its vault, ready to claim. */
function liquidBaton(chain, amount = 40) {
  const id = mint(chain, { amount });
  collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: null });
  for (let i = 0; i < 4; i++) chain.advanceEpoch();
  collect(chain, ALICE, 'baton_withdraw', { token_id: id });
  return id;
}

const submit = (chain, signer, method, args) => chain.submit(signer, COLLECTION, method, args, { deposit: ONE_YOCTO });
const transfer = (chain, from, to, id) => chain.call(from, COLLECTION, 'nft_transfer', { receiver_id: to, token_id: id }, { deposit: ONE_YOCTO });

test('B1 sale during a payout is refused', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  const listing = list(chain, id, 30);
  const aliceBefore = chain.balance(ALICE);
  const bobBefore = chain.balance(BOB);

  // Alice starts claiming. The first receipt has run; the vault has not paid yet.
  const claim = submit(chain, ALICE, 'baton_claim', { token_id: id, amount: null });
  chain.step();
  assert.ok(queued(chain).some((q) => q === `${id}.pay`), 'the payout is in flight');
  assert.equal(baton(chain, id).baton.lock.op, 'Claim');

  // Bob buys the listing on offer, and Alice tries to move the token by other means.
  const buy = chain.submit(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  const move = submit(chain, ALICE, 'nft_transfer', { receiver_id: CAROL, token_id: id });
  const list2 = submit(chain, ALICE, 'baton_list', { token_id: id, price: yocto(near(5)) });
  chain.drain();

  const bought = chain.summary(buy);
  assert.equal(bought.ok, false);
  assert.match(bought.error, /not for sale/);
  assert.match(chain.summary(move).error, /mid-operation/);
  assert.match(chain.summary(list2).error, /mid-operation/);

  // The payout finished for Alice, Bob paid nothing, and the title never moved.
  assert.ok(BigInt(chain.summary(claim).value) > near('39.9'));
  assert.ok(chain.balance(ALICE) - aliceBefore > near('39.9'));
  assert.equal(chain.balance(BOB), bobBefore, 'Bob is refunded in full');
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, ALICE);
});

test('B1 the lock holds right up to the last callback of a payout', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  submit(chain, ALICE, 'baton_claim', { token_id: id, amount: null });
  chain.step();

  // Walk the payout one receipt at a time and try to move the token between every pair.
  let attempts = 0;
  while (baton(chain, id).baton.lock) {
    const queuedNow = [...chain.queue];
    chain.queue = [];
    const attempt = chain.submit(ALICE, COLLECTION, 'nft_transfer', { receiver_id: BOB, token_id: id }, { deposit: ONE_YOCTO });
    chain.step();
    chain.queue = queuedNow;
    assert.equal(chain.summary(attempt).ok, false, 'no transfer while the payout is unfinished');
    attempts++;
    chain.step();
  }
  assert.ok(attempts >= 3, `the payout really spans several receipts (${attempts})`);
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, ALICE);
});

test('B2 sale during a pool withdrawal is refused', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: null });
  for (let i = 0; i < 4; i++) chain.advanceEpoch();
  const listing = list(chain, id, 30);

  submit(chain, ALICE, 'baton_withdraw', { token_id: id });
  chain.step();
  assert.equal(baton(chain, id).baton.lock.op, 'Withdraw');

  const buy = chain.submit(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  const move = submit(chain, ALICE, 'nft_transfer', { receiver_id: BOB, token_id: id });
  chain.drain();
  assert.equal(chain.summary(buy).ok, false);
  assert.match(chain.summary(move).error, /mid-operation/);
  assert.equal(baton(chain, id).baton.lock, null);
});

test('B3 sale during an unstake is refused', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const listing = list(chain, id, 30);

  submit(chain, ALICE, 'baton_unstake', { token_id: id, amount: null });
  chain.step();
  const buy = chain.submit(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  const move = submit(chain, ALICE, 'nft_transfer', { receiver_id: BOB, token_id: id });
  chain.drain();
  assert.equal(chain.summary(buy).ok, false);
  assert.match(chain.summary(move).error, /mid-operation/);
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, ALICE);
});

test('B4 old owner is refused after a sale', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  const listing = list(chain, id, 30);
  assert.ok(chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) }).ok);

  for (const [method, args] of [
    ['baton_claim', { token_id: id, amount: null }],
    ['baton_withdraw', { token_id: id }],
    ['baton_unstake', { token_id: id, amount: null }],
    ['baton_list', { token_id: id, price: '1' }],
    ['nft_transfer', { receiver_id: ALICE, token_id: id }],
  ]) {
    const result = collect(chain, ALICE, method, args);
    assert.equal(result.ok, false, method);
    assert.match(result.error, /Only the current holder/, method);
  }

  const before = chain.balance(BOB);
  const claim = collect(chain, BOB, 'baton_claim', { token_id: id, amount: null });
  assert.ok(chain.balance(BOB) - before > near('39.9'), JSON.stringify(claim));
});

test('B5 payout goes to the holder at request time', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  const aliceBefore = chain.balance(ALICE);
  const claim = submit(chain, ALICE, 'baton_claim', { token_id: id, amount: null });
  chain.drain();
  assert.ok(chain.summary(claim).value);
  assert.ok(chain.balance(ALICE) - aliceBefore > near('39.9'));
  const log = baton(chain, id).baton.log;
  assert.equal(log.at(-1).kind, 'Paid');
  assert.equal(log.at(-1).who, ALICE);
});

test('B6 any operation voids the listing', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  const listing = list(chain, id, 30);
  collect(chain, ALICE, 'baton_claim', { token_id: id, amount: yocto(near(39)) });
  assert.equal(baton(chain, id).listing, null);

  const bobBefore = chain.balance(BOB);
  const buy = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  assert.equal(buy.ok, false);
  assert.equal(chain.balance(BOB), bobBefore);
});

function hostileReceiver(chain, id, { reject = true } = {}) {
  const receiver = 'receiver.testnet';
  const attempts = [];
  chain.mock(
    receiver,
    ({ method, args, chain: c }) => {
      if (method !== 'nft_on_transfer') throw new Panic(`unexpected ${method}`);
      // Holding the token right now, the receiver tries to empty it before handing it back.
      attempts.push(c.submit(receiver, COLLECTION, 'baton_claim', { token_id: args.token_id, amount: null }, { deposit: ONE_YOCTO }));
      attempts.push(c.submit(receiver, COLLECTION, 'baton_unstake', { token_id: args.token_id, amount: null }, { deposit: ONE_YOCTO }));
      return reject;
    },
    { balance: near(5) },
  );
  return { receiver, attempts };
}

test('B7 transfer-call receiver cannot drain', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  const { receiver, attempts } = hostileReceiver(chain, id, { reject: true });
  const liquidBefore = chain.view(id, 'liquid', {});

  const result = chain.call(ALICE, COLLECTION, 'nft_transfer_call', { receiver_id: receiver, token_id: id, msg: '' }, { deposit: ONE_YOCTO });

  assert.equal(attempts.length, 2);
  for (const attempt of attempts) {
    const seen = chain.summary(attempt);
    assert.equal(seen.ok, false);
    assert.match(seen.error, /mid-operation/);
  }
  assert.equal(chain.view(id, 'liquid', {}), liquidBefore, 'nothing left the vault');
  assert.equal(result.value, false, 'the transfer was rejected');
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, ALICE, 'the token came back');
  assert.equal(baton(chain, id).baton.lock, null);
  assert.equal(chain.view(id, 'nft_item_info', {}).owner_id, ALICE);
});

test('B7 a receiver that keeps the token becomes the holder', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  const { receiver } = hostileReceiver(chain, id, { reject: false });
  const result = chain.call(ALICE, COLLECTION, 'nft_transfer_call', { receiver_id: receiver, token_id: id, msg: '' }, { deposit: ONE_YOCTO });
  assert.equal(result.value, true);
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, receiver);
  assert.equal(baton(chain, id).baton.lock, null);
});

test('B8 approvals are refused', () => {
  const { chain } = setup();
  const id = mint(chain);
  const withApproval = chain.call(ALICE, COLLECTION, 'nft_transfer', { receiver_id: BOB, token_id: id, approval_id: 1 }, { deposit: ONE_YOCTO });
  assert.match(withApproval.error, /Approvals are not offered/);
  const approve = chain.call(ALICE, COLLECTION, 'nft_approve', { token_id: id, account_id: BOB }, { deposit: ONE_YOCTO });
  assert.match(approve.error, /MethodNotFound/);
});

test('C1 fake pools are refused', () => {
  const { chain } = setup();
  chain.mock('fake.evil.testnet', () => ({ account_id: 'x', staked_balance: yocto(near(10000)), unstaked_balance: '0', can_withdraw: true }));
  for (const pool of ['fake.evil.testnet', 'pool.f863973.m0', 'a.b.pool.f863973.m0', 'poolx.f863973.m0', `x.pool.f863973.m0.evil.testnet`]) {
    const result = chain.call(MALLORY, COLLECTION, 'baton_mint', { pool }, { deposit: near(2) });
    assert.equal(result.ok, false, pool);
    assert.match(result.error, /official factory/, pool);
  }
  assert.equal(chain.view(COLLECTION, 'nft_total_supply', {}), '0');
});

test('C2 resetting the unbonding clock voids the listing', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: yocto(near(30)) });
  for (let i = 0; i < 3; i++) chain.advanceEpoch();
  const before = baton(chain, id);
  assert.equal(BigInt(before.baton.unlock_epoch) - BigInt(before.epoch), 1n, 'the wait is nearly over');
  const listing = list(chain, id, 20);

  // One more tiny unstake. The pool restarts the wait for the whole unbonding balance.
  assert.equal(collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: yocto(near('0.001')) }).value, true);
  assert.equal(baton(chain, id).listing, null, 'the listing the buyer saw is gone');

  const buy = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(20) });
  assert.equal(buy.ok, false);

  // Confirms the attack is real: the official pool did restart the clock.
  chain.advanceEpoch();
  assert.equal(chain.view(POOL, 'is_account_unstaked_balance_available', { account_id: id }), false);
});

test('C3 price change cannot catch a buyer', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const cheap = list(chain, id, 30);
  const dear = list(chain, id, 39);
  assert.notEqual(cheap.id, dear.id);

  const before = chain.balance(BOB);
  const buy = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: cheap.id }, { deposit: near(39) });
  assert.equal(buy.ok, false, 'bob named the listing that was on offer');
  assert.match(buy.error, /listing has changed/);
  assert.equal(chain.balance(BOB), before);
});

test('C4 transfer voids the listing', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const listing = list(chain, id, 30);
  assert.ok(transfer(chain, ALICE, CAROL, id).ok);
  assert.equal(baton(chain, id).listing, null);
  const buy = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  assert.equal(buy.ok, false);
  assert.match(buy.error, /not for sale/);
});

test('C5 cannot list mid-operation', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });

  submit(chain, ALICE, 'baton_unstake', { token_id: id, amount: null });
  chain.step();
  const during = submit(chain, ALICE, 'baton_list', { token_id: id, price: yocto(near(30)) });
  chain.drain();
  assert.match(chain.summary(during).error, /mid-operation/);

  // And nothing can change while a listing is taking its own snapshot.
  const opening = submit(chain, ALICE, 'baton_list', { token_id: id, price: yocto(near(30)) });
  chain.step();
  assert.equal(baton(chain, id).baton.lock.op, 'List');
  const sneak = submit(chain, ALICE, 'baton_claim', { token_id: id, amount: null });
  chain.drain();
  assert.match(chain.summary(sneak).error, /mid-operation/);
  assert.equal(chain.summary(opening).value, true);
  assert.ok(baton(chain, id).listing, 'the listing opened once the snapshot returned');
});

test('E1 failed operation releases the lock', () => {
  const { chain } = setup();
  const pool = 'flaky.pool.f863973.m0';
  const state = flakyPool(chain, pool);
  const id = mint(chain, { amount: 10, pool });

  state.refuse.add('unstake_all');
  const failed = collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: null });
  assert.equal(failed.value, true, 'the operation finishes and reports through the snapshot');
  assert.equal(baton(chain, id).baton.lock, null, 'lock released');
  assert.equal(baton(chain, id).baton.log.at(-1).kind, 'Staked', 'no unbonding was recorded');

  state.refuse.add('get_account');
  state.refuse.delete('unstake_all');
  const blind = collect(chain, ALICE, 'baton_list', { token_id: id, price: '1' });
  assert.equal(blind.value, false, 'a listing without a snapshot does not open');
  assert.equal(baton(chain, id).listing, null);
  assert.equal(baton(chain, id).baton.lock, null, 'and the lock is released anyway');
});

test('E1 a stake the pool refuses stays in the vault as the holder\'s liquid NEAR', () => {
  const { chain } = setup();
  const pool = 'flaky.pool.f863973.m0';
  const state = flakyPool(chain, pool);
  state.refuse.add('deposit_and_stake');
  const id = mint(chain, { amount: 10, pool, tolerate: true });
  const view = baton(chain, id);
  assert.equal(view.baton.lock, null);
  assert.equal(view.status, 'Ready to claim');
  assert.equal(view.baton.log.at(-1).kind, 'StakeReturned');
  assert.equal(view.baton.earned, '0');
  assert.equal(chain.view(id, 'liquid', {}), yocto(near(10)));
});

test('E2 stuck lock can be released after the timeout', () => {
  const { chain } = setup();
  const id = liquidBaton(chain);
  submit(chain, ALICE, 'baton_claim', { token_id: id, amount: null });
  chain.step();
  assert.ok(baton(chain, id).baton.lock);

  const held = [...chain.queue];
  chain.queue = [];
  const early = chain.call(MALLORY, COLLECTION, 'baton_unstick', { token_id: id });
  assert.match(early.error, /not timed out/);

  chain.height += 8_000n;
  assert.ok(chain.call(MALLORY, COLLECTION, 'baton_unstick', { token_id: id }).ok);
  assert.equal(baton(chain, id).baton.lock, null);

  // The late callback of the old lock must not touch anything.
  const version = baton(chain, id).baton.version;
  chain.queue = held;
  chain.drain();
  assert.equal(baton(chain, id).baton.version, version);
  assert.equal(baton(chain, id).baton.lock, null);
});

test('E3 sync takes no lock', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });

  const sync = chain.submit(MALLORY, COLLECTION, 'baton_sync', { token_id: id });
  chain.step();
  assert.equal(baton(chain, id).baton.lock, null, 'a stranger cannot lock a Baton');

  // The holder can act while the sync is in flight, and the stale snapshot is then dropped.
  const staked = baton(chain, id).baton.staked;
  assert.ok(transfer(chain, ALICE, BOB, id).ok);
  chain.drain();
  assert.equal(chain.summary(sync).value, false, 'stale snapshot dropped');
  assert.equal(baton(chain, id).baton.staked, staked);
});

test('E4 history stays within its cap', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 5 });
  const people = [ALICE, BOB, CAROL];
  let holder = 0;
  for (let i = 0; i < 60; i++) {
    const next = (holder + 1) % people.length;
    assert.ok(transfer(chain, people[holder], people[next], id).ok);
    holder = next;
  }
  const { legs, legs_total, log, log_total } = baton(chain, id).baton;
  assert.equal(legs.length, 12);
  assert.equal(legs_total, 61);
  assert.equal(legs[0].holder, ALICE, 'the original holder is always kept');
  assert.equal(log.length, 24);
  assert.ok(log_total > 60);
});

test('E4 a Baton at its caps still fits in what was paid at mint, even with long names', () => {
  const { chain } = setup();
  const long = (c) => `${c.repeat(56)}.testnet`;
  const people = [long('a'), long('b'), long('c')];
  for (const id of people) chain.account(id, near(100));
  const before = chain.get(COLLECTION).storage;
  const size = (storage) => [...storage].reduce((total, [k, v]) => total + k.length / 2 + v.length + 40, 0);
  const start = size(before);

  const id = mint(chain, { from: people[0], amount: 5 });
  let holder = 0;
  for (let i = 0; i < 40; i++) {
    const next = (holder + 1) % people.length;
    assert.ok(transfer(chain, people[holder], people[next], id).ok);
    holder = next;
  }
  list(chain, id, 1, people[holder]);

  const used = BigInt(size(chain.get(COLLECTION).storage) - start) * 10_000_000_000_000_000_000n;
  assert.ok(used <= near('0.05'), `one Baton uses ${used} yoctoNEAR of storage`);
});

test('E5 bounced proceeds stay claimable', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const listing = list(chain, id, 30);

  const seller = chain.get(ALICE);
  chain.accounts.delete(ALICE);
  const buy = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  assert.ok(buy.ok, 'the sale completes even though the seller is gone');
  assert.equal(chain.view(COLLECTION, 'nft_token', { token_id: id }).owner_id, BOB);
  const owed = chain.view(COLLECTION, 'baton_pending_refund', { account_id: ALICE });
  assert.equal(owed, yocto((near(30) * 9990n) / 10000n));

  chain.accounts.set(ALICE, seller);
  const before = chain.balance(ALICE);
  assert.ok(chain.call(ALICE, COLLECTION, 'baton_claim_refund', {}).ok);
  assert.equal(chain.balance(ALICE) - before, BigInt(owed));
  assert.equal(chain.view(COLLECTION, 'baton_pending_refund', { account_id: ALICE }), '0');
});
