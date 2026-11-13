// Shared set-up: a local chain running the compiled Baton contracts against the staking pool code
// deployed on testnet. The pool wasm in tests/fixtures is the exact bytes of 01node.pool.f863973.m0.

import { readFileSync } from 'node:fs';
import { Chain, Panic, TGAS, near } from '../tools/localnet/chain.mjs';

export const VAULT_WASM = readFileSync(new URL('../res/baton_vault.wasm', import.meta.url));
export const COLLECTION_WASM = readFileSync(new URL('../res/baton_collection.wasm', import.meta.url));
export const POOL_WASM = readFileSync(new URL('./fixtures/staking_pool_testnet.wasm', import.meta.url));

export const COLLECTION = 'baton.testnet';
export const POOL = 'good.pool.f863973.m0';
export const POOL_SUFFIX = '.pool.f863973.m0';
export const TREASURY = 'treasury.testnet';
export const FEE_BPS = 10;
export const ONE_YOCTO = 1n;
export const [ALICE, BOB, CAROL, MALLORY] = ['alice.testnet', 'bob.testnet', 'carol.testnet', 'mallory.testnet'];

/** Staking pools take a validator key at creation. This one is never used to sign anything. */
const POOL_KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

export function deployPool(chain, id = POOL, feePercent = 10) {
  chain.deploy(id, POOL_WASM);
  chain.get(id).balance = near(1000);
  chain.get(id).keys = 0;
  const init = chain.call(ALICE, id, 'new', {
    owner_id: 'validator.testnet',
    stake_public_key: POOL_KEY,
    reward_fee_fraction: { numerator: feePercent, denominator: 100 },
  });
  if (!init.ok) throw new Error(`pool init failed: ${init.error} ${JSON.stringify(init.failures)}`);
}

export function setup({ feeBps = FEE_BPS } = {}) {
  const chain = new Chain();
  for (const id of [ALICE, BOB, CAROL, MALLORY, 'validator.testnet', TREASURY]) chain.account(id, near(5000));
  deployPool(chain);
  const vaultHash = chain.publishGlobal(VAULT_WASM);
  chain.deploy(COLLECTION, COLLECTION_WASM);
  chain.get(COLLECTION).balance = near(50);
  chain.get(COLLECTION).keys = 0;
  const init = chain.call(MALLORY, COLLECTION, 'new', { vault_code_hash: vaultHash, pool_suffix: POOL_SUFFIX, fee_bps: feeBps, treasury: TREASURY });
  if (!init.ok) throw new Error(`collection init failed: ${init.error}`);
  return { chain, vaultHash };
}

export const baton = (chain, id) => chain.view(COLLECTION, 'baton_get', { token_id: id });
export const yocto = (value) => value.toString();

export function mint(chain, { from = ALICE, amount = 100, pool = POOL, receiver_id = null, tolerate = false } = {}) {
  const deposit = near(amount) + near('0.06');
  const result = chain.call(from, COLLECTION, 'baton_mint', { pool, receiver_id }, { deposit, gas: 300n * TGAS });
  if ((result.failures.length && !tolerate) || result.value !== true) {
    throw new Error(`mint failed: ${result.error} ${JSON.stringify(result.failures)} -> ${JSON.stringify(result.value)}`);
  }
  const event = result.events.find((e) => e.event === 'nft_mint');
  return event.data[0].token_ids[0];
}

export const collect = (chain, signer, method, args = {}, options = {}) => chain.call(signer, COLLECTION, method, args, { deposit: ONE_YOCTO, ...options });

export function list(chain, token, price, from = ALICE) {
  const result = collect(chain, from, 'baton_list', { token_id: token, price: yocto(near(price)) });
  if (result.value !== true) throw new Error(`list failed: ${JSON.stringify(result)}`);
  return baton(chain, token).listing;
}

/** Everything still queued, as `receiver.method`, in the order it will run. */
export const queued = (chain) => chain.queue.map((r) => `${r.receiver}.${r.actions.map((a) => a.method ?? a.type).join('+')}`);

/** Runs receipts until the next one queued matches `match`, leaving it unrun. */
export function runUntil(chain, match) {
  for (let i = 0; i < 40; i++) {
    if (queued(chain).some((q) => q.includes(match))) return;
    if (chain.queue.length === 0) throw new Error(`queue drained before ${match}`);
    chain.step();
  }
  throw new Error(`never reached ${match}`);
}

/** A pool whose behaviour a test controls, for injecting failures. */
export function flakyPool(chain, id, state = { refuse: new Set(), accounts: new Map() }) {
  chain.mock(
    id,
    ({ method, args, predecessor, deposit, self }) => {
      if (state.refuse.has(method)) throw new Panic('pool refused');
      const entry = state.accounts.get(predecessor) ?? { staked: 0n, unstaked: 0n };
      if (method === 'get_account') {
        const held = state.accounts.get(args.account_id) ?? { staked: 0n, unstaked: 0n };
        return { account_id: args.account_id, staked_balance: yocto(held.staked), unstaked_balance: yocto(held.unstaked), can_withdraw: true };
      }
      if (method === 'deposit_and_stake') {
        entry.staked += deposit;
        state.accounts.set(predecessor, entry);
      }
      return undefined;
    },
    { balance: near(10) },
  );
  return state;
}
