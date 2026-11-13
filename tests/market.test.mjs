// Listings, fees, and standing bids that let a holder exit in one transaction.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { near } from '../tools/localnet/chain.mjs';
import { ALICE, BOB, CAROL, COLLECTION, ONE_YOCTO, POOL, TREASURY, baton, collect, list, mint, runUntil, setup, yocto } from './harness.mjs';

const close = (actual, expected, tolerance = near('0.001')) => {
  const diff = BigInt(actual) - BigInt(expected);
  assert.ok((diff < 0n ? -diff : diff) <= tolerance, `${actual} is not close to ${expected}`);
};

const placeBid = (chain, { from = BOB, amount = 200, discount = 50, epochs = 4 } = {}) => {
  const result = chain.call(from, COLLECTION, 'baton_bid', { discount_bps: discount, max_epochs: epochs }, { deposit: near(amount) + near('0.005') });
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};
const fill = (chain, id, bid, minPrice = '0', from = ALICE) => collect(chain, from, 'baton_fill', { token_id: id, bid_id: bid, min_price: minPrice });

test('F1 underpayment fails and overpayment is refunded', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const listing = list(chain, id, 30);

  const short = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(29) });
  assert.match(short.error, /below the price/);

  const before = chain.balance(BOB);
  const buy = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(35) });
  assert.ok(buy.ok);
  assert.equal(before - chain.balance(BOB), near(30), 'bob paid the price and not a yocto more');
});

test('a sale pays the seller and takes the 0.1% fee, and a seller cannot buy their own', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const listing = list(chain, id, 30);
  const own = chain.call(ALICE, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  assert.match(own.error, /already hold/);

  const seller = chain.balance(ALICE);
  const treasury = chain.balance(TREASURY);
  assert.ok(chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) }).ok);
  assert.equal(chain.balance(ALICE) - seller, (near(30) * 9990n) / 10000n);
  assert.equal(chain.balance(TREASURY) - treasury, (near(30) * 10n) / 10000n);
});

test('delisting removes the offer', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const listing = list(chain, id, 30);
  assert.equal(chain.view(COLLECTION, 'baton_listings', {}).length, 1);
  assert.ok(collect(chain, ALICE, 'baton_delist', { token_id: id }).ok);
  assert.equal(chain.view(COLLECTION, 'baton_listings', {}).length, 0);
  const buy = chain.call(BOB, COLLECTION, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: near(30) });
  assert.equal(buy.ok, false);
});

test('instant exit: a holder sells into a standing bid in one transaction', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 100 });
  const bid = placeBid(chain, { amount: 200, discount: 50 });

  const seller = chain.balance(ALICE);
  const result = fill(chain, id, bid);
  assert.equal(result.value, true, JSON.stringify(result.failures));

  const view = baton(chain, id);
  assert.equal(view.baton.owner, BOB);
  assert.equal(view.baton.lock, null);
  assert.equal(chain.view(id, 'nft_item_info', {}).owner_id, BOB);
  close(chain.view(POOL, 'get_account', { account_id: id }).staked_balance, near(100));

  // 100 NEAR less the 0.5% bid discount, less the 0.1% fee on the sale.
  const expected = (((near(100) * 9950n) / 10000n) * 9990n) / 10000n;
  close(chain.balance(ALICE) - seller, expected);

  const [remaining] = chain.view(COLLECTION, 'baton_bids', {});
  close(remaining.remaining, near(200) - (near(100) * 9950n) / 10000n);
});

test('a bid can be sold into while the NEAR is unbonding, if it is soon enough', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 20 });
  collect(chain, ALICE, 'baton_unstake', { token_id: id, amount: null });
  chain.advanceEpoch();
  chain.advanceEpoch();
  chain.advanceEpoch();
  const bid = placeBid(chain, { amount: 50, discount: 30, epochs: 1 });
  assert.equal(fill(chain, id, bid).value, true);
  assert.equal(baton(chain, id).baton.owner, BOB);

  chain.advanceEpoch();
  assert.equal(collect(chain, BOB, 'baton_withdraw', { token_id: id }).value, true);
});

test('F2 cancelled bid fails cleanly', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const bid = placeBid(chain, { amount: 100 });

  const filling = chain.submit(ALICE, COLLECTION, 'baton_fill', { token_id: id, bid_id: bid, min_price: '0' }, { deposit: ONE_YOCTO });
  runUntil(chain, 'on_snapshot');

  const before = chain.balance(BOB);
  const queuedNow = [...chain.queue];
  chain.queue = [];
  const cancel = chain.call(BOB, COLLECTION, 'baton_bid_cancel', { bid_id: bid });
  assert.ok(cancel.ok);
  chain.queue = queuedNow;
  chain.drain();

  assert.equal(chain.summary(filling).value, false);
  const view = baton(chain, id);
  assert.equal(view.baton.owner, ALICE, 'nothing moved');
  assert.equal(view.baton.lock, null);
  assert.equal(chain.balance(BOB) - before, near(100) + near('0.005'), 'bid and storage returned');
});

test('F3 fill honours the minimum price', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 100 });
  const bid = placeBid(chain, { amount: 200, discount: 500 });
  const result = fill(chain, id, bid, yocto(near(99)));
  assert.equal(result.value, false);
  assert.equal(baton(chain, id).baton.owner, ALICE);
  assert.equal(baton(chain, id).baton.lock, null);
});

test('F4 fill honours the epoch limit', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 20 });
  const bid = placeBid(chain, { amount: 50, epochs: 1 });
  assert.equal(fill(chain, id, bid).value, false, 'staked NEAR is 4 epochs away');
  assert.equal(baton(chain, id).baton.owner, ALICE);
});

test('a bid cannot pay more than it holds, and a bidder cannot sell to themselves', () => {
  const { chain } = setup();
  const small = mint(chain, { amount: 100 });
  const bid = placeBid(chain, { amount: 10 });
  assert.equal(fill(chain, small, bid).value, false, 'bid is too small');

  const own = mint(chain, { from: BOB, amount: 5 });
  assert.equal(fill(chain, own, bid, '0', BOB).value, false, 'a bidder cannot fill their own bid');
  assert.equal(baton(chain, own).baton.owner, BOB);
});

test('an exhausted bid closes and returns what is left', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 10 });
  const bid = placeBid(chain, { amount: 9.95, discount: 100 });
  const before = chain.balance(BOB);
  assert.equal(fill(chain, id, bid).value, true);
  assert.equal(chain.view(COLLECTION, 'baton_bids', {}).length, 0);
  close(chain.balance(BOB) - before, near('0.05') + near('0.005'));
});

test('only the bidder can cancel a bid', () => {
  const { chain } = setup();
  const bid = placeBid(chain);
  const result = chain.call(CAROL, COLLECTION, 'baton_bid_cancel', { bid_id: bid });
  assert.match(result.error, /Only the bidder/);
});

test('a holder cannot fill a bid while the Baton is locked', () => {
  const { chain } = setup();
  const id = mint(chain, { amount: 40 });
  const bid = placeBid(chain, { amount: 100 });
  chain.submit(ALICE, COLLECTION, 'baton_unstake', { token_id: id, amount: null }, { deposit: ONE_YOCTO });
  chain.step();
  const attempt = chain.submit(ALICE, COLLECTION, 'baton_fill', { token_id: id, bid_id: bid, min_price: '0' }, { deposit: ONE_YOCTO });
  chain.drain();
  assert.match(chain.summary(attempt).error, /mid-operation/);
});
