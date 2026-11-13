// A private practice chain: the real compiled contracts and the real staking pool code running in
// this process. No wallet, no test NEAR, and time can be skipped. Everything here is sample data.

import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Chain, TGAS, base58encode, near } from '../tools/localnet/chain.mjs';
import { MESSAGE, RECIPIENT, nep413Hash } from './room.mjs';

const file = (path) => readFileSync(new URL(path, import.meta.url));
const VAULT = file('../res/baton_vault.wasm');
const COLLECTION_WASM = file('../res/baton_collection.wasm');
const POOL_WASM = file('../tests/fixtures/staking_pool_testnet.wasm');

export const COLLECTION = 'baton.testnet';
const POOL_SUFFIX = '.pool.f863973.m0';
const TREASURY = 'treasury.testnet';
const POOL_KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const ONE_YOCTO = 1n;
const EPOCHS_PER_YEAR = 1250n;
const REWARD_RATE_PERCENT = 9n;

const POOLS = [
  ['stakely_v2', 3],
  ['01node', 10],
  ['aurora', 9],
  ['pennyvalidators', 4],
];

export const PERSONAS = [
  { id: 'maya.testnet', name: 'Maya', blurb: 'Staked 120 NEAR and needs the money today' },
  { id: 'sam.testnet', name: 'Sam', blurb: 'Keeps idle NEAR ready to buy batons at a discount' },
  { id: 'ren.testnet', name: 'Ren', blurb: 'Holds a few batons, some on the market' },
  { id: 'nobody.testnet', name: 'A stranger', blurb: 'Holds nothing here' },
];

const rawPublicKey = (keyObject) => keyObject.export({ format: 'jwk' }).x;

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(rawPublicKey(publicKey), 'base64url');
  return { privateKey, publicKey: `ed25519:${base58encode(raw)}` };
}

export function createLocal() {
  const local = {
    chain: null,
    keys: new Map(),
    vaultHash: null,

    reset() {
      // Starts in the past so that, after the seeded epochs, the clock reads about today.
      const chain = new Chain({ now: BigInt(Date.now() - 39 * 86_400_000) * 1_000_000n });
      this.chain = chain;
      this.keys = new Map();
      for (const { id } of PERSONAS) {
        chain.account(id, near(id === 'nobody.testnet' ? 25 : 2000));
        this.keys.set(id, makeKeys());
      }
      chain.account(TREASURY, near(1));
      chain.account('validators.testnet', near(1));

      for (const [name, fee] of POOLS) {
        const id = `${name}${POOL_SUFFIX}`;
        chain.deploy(id, POOL_WASM);
        chain.get(id).balance = near(40000);
        chain.get(id).keys = 0;
        must(chain.call(TREASURY, id, 'new', { owner_id: 'validators.testnet', stake_public_key: POOL_KEY, reward_fee_fraction: { numerator: fee, denominator: 100 } }));
      }

      this.vaultHash = chain.publishGlobal(VAULT);
      chain.deploy(COLLECTION, COLLECTION_WASM);
      chain.get(COLLECTION).balance = near(50);
      chain.get(COLLECTION).keys = 0;
      must(chain.call(TREASURY, COLLECTION, 'new', { vault_code_hash: this.vaultHash, pool_suffix: POOL_SUFFIX, fee_bps: 10, treasury: TREASURY }));
      this.seed();
    },

    seed() {
      const { chain } = this;
      const pool = (name) => `${name}${POOL_SUFFIX}`;
      const mint = (from, amount, poolId) => {
        const result = must(chain.call(from, COLLECTION, 'baton_mint', { pool: poolId }, { deposit: near(amount) + near('0.06'), gas: 300n * TGAS }));
        return result.events.find((e) => e.event === 'nft_mint').data[0].token_ids[0];
      };
      const act = (from, method, args, deposit = ONE_YOCTO) => must(chain.call(from, COLLECTION, method, args, { deposit, gas: 300n * TGAS }));

      // Maya's Baton: staked about 40 days ago, and the one being sold in the demo.
      const mayas = mint('maya.testnet', 120, pool('stakely_v2'));

      // Others on the market, at different stages.
      const liveStake = mint('ren.testnet', 40, pool('01node'));
      const lateStage = mint('ren.testnet', 250, pool('aurora'));
      const lastLap = mint('ren.testnet', 75, pool('pennyvalidators'));

      this.skip(130);
      act('ren.testnet', 'baton_unstake', { token_id: lateStage, amount: null });
      this.skip(2);
      act('ren.testnet', 'baton_unstake', { token_id: lastLap, amount: null });
      this.skip(1);

      const worth = (id) => {
        const { staked, unstaked, liquid } = chain.view(COLLECTION, 'baton_get', { token_id: id }).baton;
        return BigInt(staked) + BigInt(unstaked) + BigInt(liquid);
      };
      for (const id of [mayas, liveStake, lateStage, lastLap]) chain.call(TREASURY, COLLECTION, 'baton_sync', { token_id: id });

      const priceAt = (id, bps) => (worth(id) * (10_000n - bps)) / 10_000n;
      act('ren.testnet', 'baton_list', { token_id: liveStake, price: priceAt(liveStake, 60n).toString() });
      act('ren.testnet', 'baton_list', { token_id: lateStage, price: priceAt(lateStage, 8n).toString() });
      act('ren.testnet', 'baton_list', { token_id: lastLap, price: priceAt(lastLap, 20n).toString() });

      act('sam.testnet', 'baton_bid', { discount_bps: 25, max_epochs: 4 }, near(800) + near('0.005'));
      act('ren.testnet', 'baton_bid', { discount_bps: 60, max_epochs: 4 }, near(300) + near('0.005'));
    },

    /** Moves time on by whole epochs, paying each pool its validator rewards. */
    skip(epochs) {
      const { chain } = this;
      for (let i = 0; i < epochs; i++) {
        const rewards = {};
        for (const [name] of POOLS) {
          const id = `${name}${POOL_SUFFIX}`;
          const staked = BigInt(chain.view(id, 'get_total_staked_balance', {}));
          rewards[id] = (staked * REWARD_RATE_PERCENT) / (100n * EPOCHS_PER_YEAR);
        }
        chain.advanceEpoch(rewards);
        for (const [name] of POOLS) chain.call(TREASURY, `${name}${POOL_SUFFIX}`, 'ping', {});
      }
    },

    /** What a wallet does for NEP-413: signs the hash with this persona's full-access key. */
    signMessage(accountId, { nonce, message = MESSAGE, recipient = RECIPIENT }) {
      const keys = this.keys.get(accountId);
      if (!keys) throw new Error(`no such persona: ${accountId}`);
      const signature = sign(null, nep413Hash({ message, nonce: Buffer.from(nonce, 'base64'), recipient }), keys.privateKey);
      return { accountId, publicKey: keys.publicKey, signature: signature.toString('base64') };
    },

    reader() {
      const self = this;
      return {
        async token(tokenId) {
          const view = self.chain.view(COLLECTION, 'baton_get', { token_id: tokenId });
          return view ? { owner: view.baton.owner, rotationSeq: view.baton.rotation_seq, pool: view.baton.pool } : null;
        },
        async keyPermission(accountId, publicKey) {
          return self.keys.get(accountId)?.publicKey === publicKey ? 'FullAccess' : null;
        },
        async rpc() {
          return { jsonrpc: '2.0', id: 'baton', result: { chain_id: 'baton-local', latest_block_height: Number(self.chain.height), note: 'Served to the current holder only.' } };
        },
      };
    },
  };
  local.reset();
  return local;
}

function must(result) {
  if (!result.ok || result.value === false) throw new Error(`seed failed: ${result.error} ${JSON.stringify(result.failures)}`);
  return result;
}

export const POOL_IDS = POOLS.map(([name]) => `${name}${POOL_SUFFIX}`);
