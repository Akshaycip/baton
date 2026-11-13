// Section A of the threat model: nobody keeps a way into the account.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { near } from '../tools/localnet/chain.mjs';
import { ALICE, BOB, COLLECTION, COLLECTION_WASM, MALLORY, ONE_YOCTO, POOL, VAULT_WASM, baton, mint, setup } from './harness.mjs';

function readWasm(bytes) {
  const leb = (i) => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[i++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return [result, i];
    }
  };
  const text = (i) => {
    const [length, start] = leb(i);
    return [Buffer.from(bytes.subarray(start, start + length)).toString(), start + length];
  };
  const imports = [];
  const exports = [];
  let i = 8;
  while (i < bytes.length) {
    const section = bytes[i++];
    let size;
    [size, i] = leb(i);
    const end = i + size;
    if (section === 2 || section === 7) {
      let [count, at] = leb(i);
      for (; count > 0; count--) {
        let name;
        if (section === 2) [, at] = text(at);
        [name, at] = text(at);
        const kind = bytes[at++];
        [, at] = leb(at);
        if (kind === 0) (section === 2 ? imports : exports).push(name);
      }
    }
    i = end;
  }
  return { imports: imports.sort(), exports: exports.sort() };
}

const borshAccount = (id) => {
  const name = Buffer.from(id);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(name.length);
  return Buffer.concat([length, name]);
};
const borshU64 = (n) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(n));
  return out;
};
const borshU128 = (n) => Buffer.concat([borshU64(BigInt(n) & ((1n << 64n) - 1n)), borshU64(BigInt(n) >> 64n)]);
const bytes = (...parts) => new Uint8Array(Buffer.concat(parts));

test('A1 vault has no access keys', () => {
  const { chain } = setup();
  const id = mint(chain);
  assert.equal(chain.keys(id), 0);
});

test('A2 A3 vault wasm cannot add keys or deploy', () => {
  const { imports } = readWasm(VAULT_WASM);
  for (const forbidden of imports) {
    assert.doesNotMatch(forbidden, /add_key|add_gas_key|delete_key|deploy|delete_account|create_account|action_stake|use_global/, `vault imports ${forbidden}`);
  }
  // The full list, so that any new capability has to be justified here.
  assert.deepEqual(imports, [
    'account_balance',
    'attached_deposit',
    'current_account_id',
    'input',
    'panic_utf8',
    'predecessor_account_id',
    'promise_batch_action_function_call',
    'promise_batch_action_transfer',
    'promise_batch_create',
    'promise_batch_then',
    'promise_result',
    'promise_results_count',
    'promise_return',
    'read_register',
    'register_len',
    'storage_has_key',
    'storage_read',
    'storage_usage',
    'storage_write',
    'value_return',
  ]);
});

test('A3 vault code is attached by hash and matches the published wasm', () => {
  const { chain, vaultHash } = setup();
  const id = mint(chain);
  assert.equal(chain.get(id).codeHash, vaultHash);
  assert.equal(chain.view(COLLECTION, 'baton_config', {}).vault_code_hash, vaultHash);
});

test('A4 only the collection can instruct a vault', () => {
  const { chain } = setup();
  const id = mint(chain);
  const attempts = [
    ['stake', bytes(borshU128(near(1)))],
    ['unstake', bytes(Buffer.from([0]))],
    ['withdraw', new Uint8Array()],
    ['pay', bytes(borshAccount(MALLORY), Buffer.from([0]))],
    ['rotate', bytes(borshAccount(MALLORY), borshU64(99))],
  ];
  for (const [method, args] of attempts) {
    const result = chain.call(MALLORY, id, method, args);
    assert.equal(result.ok, false, `${method} should be refused`);
    assert.match(result.error, /Only the collection/, method);
  }
  const again = chain.call(COLLECTION, id, 'init', bytes(borshAccount(POOL), borshAccount(MALLORY)));
  assert.equal(again.ok, false, 'a vault initialises once');
  assert.match(again.error, /already been initialized/i);
});

test('A5 callbacks cannot be forged', () => {
  const { chain } = setup();
  const id = mint(chain);
  const vaultCallbacks = [
    ['on_pool', new Uint8Array()],
    ['on_paid', bytes(borshU128(1))],
  ];
  for (const [method, args] of vaultCallbacks) {
    const result = chain.call(MALLORY, id, method, args);
    assert.equal(result.ok, false, method);
    assert.match(result.error, /is private/, method);
  }
  const lock = '1';
  const collectionCallbacks = [
    ['on_vault_created', { token_id: id, owner: MALLORY, payer: MALLORY, pool: POOL, stake: '1', deposit: '1' }],
    ['on_staked', { token_id: id, lock, amount: '1', payer: null }],
    ['on_unstaked', { token_id: id, lock }],
    ['on_withdrawn', { token_id: id, lock }],
    ['on_claimed', { token_id: id, lock, holder: MALLORY }],
    ['on_snapshot', { token_id: id, lock, after: 'Release' }],
    ['on_proceeds', { seller: MALLORY, amount: '1' }],
    ['nft_resolve_transfer', { owner_id: MALLORY, receiver_id: ALICE, token_id: id, lock }],
  ];
  for (const [method, args] of collectionCallbacks) {
    const result = chain.call(MALLORY, COLLECTION, method, args);
    assert.equal(result.ok, false, method);
    assert.match(result.error, /is private/, method);
  }
});

test('A6 collection has no admin surface', () => {
  const { exports } = readWasm(COLLECTION_WASM);
  for (const name of exports) {
    assert.doesNotMatch(name, /admin|owner_set|upgrade|migrate|pause|set_|deploy|add_key/, `unexpected method ${name}`);
  }
  const again = setup().chain;
  const result = again.call(MALLORY, COLLECTION, 'new', { vault_code_hash: '11111111111111111111111111111111', pool_suffix: '.evil.testnet', fee_bps: 100, treasury: MALLORY });
  assert.equal(result.ok, false, 'configuration is set once');
  assert.ok(COLLECTION_WASM.length > 0 && readFileSync);
});

test('A7 token ids are the collection\'s own sub-accounts', () => {
  const { chain } = setup();
  const id = mint(chain);
  assert.ok(id.endsWith(`.${COLLECTION}`));
  assert.equal(id.split('.').length, COLLECTION.split('.').length + 1);
  assert.equal(chain.view(id, 'vault_info', {}).collection_id, COLLECTION);
});

test('B9 pool is pinned', () => {
  const { chain } = setup();
  const id = mint(chain);
  assert.equal(chain.view(id, 'vault_info', {}).pool_id, POOL);
  const { exports } = readWasm(VAULT_WASM);
  assert.deepEqual(exports, ['contract_source_metadata', 'init', 'liquid', 'nft_item_info', 'on_paid', 'on_pool', 'pay', 'rotate', 'stake', 'unstake', 'vault_info', 'withdraw']);
});

test('sharded item pair check passes: vault and collection agree on the owner', () => {
  const { chain } = setup();
  const id = mint(chain);
  const check = () => {
    const item = chain.view(id, 'nft_item_info', {});
    const token = chain.view(COLLECTION, 'nft_token', { token_id: id });
    assert.equal(item.spec, 'sharded-item-1.0.0');
    assert.equal(item.init, true);
    assert.equal(item.status, 'Active');
    assert.equal(item.collection_id, COLLECTION);
    assert.equal(item.token_id, id);
    assert.equal(item.owner_id, token.owner_id);
    assert.equal(item.rotation_seq, baton(chain, id).baton.rotation_seq);
    return item;
  };
  assert.equal(check().owner_id, ALICE);
  assert.ok(chain.call(ALICE, COLLECTION, 'nft_transfer', { receiver_id: BOB, token_id: id }, { deposit: ONE_YOCTO }).ok);
  assert.equal(check().owner_id, BOB);
  assert.equal(check().rotation_seq, '2');
  assert.equal(chain.view(COLLECTION, 'config_epoch', {}), 1);
});

test('rotation only moves forward, whatever order messages arrive in', () => {
  const { chain } = setup();
  const id = mint(chain);
  chain.call(ALICE, COLLECTION, 'nft_transfer', { receiver_id: BOB, token_id: id }, { deposit: ONE_YOCTO });
  const stale = chain.call(COLLECTION, id, 'rotate', bytes(borshAccount(MALLORY), borshU64(1)));
  assert.ok(stale.ok);
  assert.equal(chain.view(id, 'nft_item_info', {}).owner_id, BOB);
});

test('NEP-171 surface: metadata and enumeration', () => {
  const { chain } = setup();
  const id = mint(chain);
  const second = mint(chain, { from: BOB });
  const metadata = chain.view(COLLECTION, 'nft_metadata', {});
  assert.equal(metadata.spec, 'nft-1.0.0');
  assert.equal(metadata.symbol, 'BATON');
  assert.equal(chain.view(COLLECTION, 'nft_total_supply', {}), '2');
  assert.equal(chain.view(COLLECTION, 'nft_supply_for_owner', { account_id: ALICE }), '1');
  assert.deepEqual(chain.view(COLLECTION, 'nft_tokens', {}).map((t) => t.token_id), [id, second]);
  assert.deepEqual(chain.view(COLLECTION, 'nft_tokens_for_owner', { account_id: BOB }).map((t) => t.token_id), [second]);
  const transfer = chain.call(ALICE, COLLECTION, 'nft_transfer', { receiver_id: BOB, token_id: id }, { deposit: ONE_YOCTO });
  const event = transfer.events.find((e) => e.event === 'nft_transfer');
  assert.equal(event.standard, 'nep171');
  assert.deepEqual(event.data[0].token_ids, [id]);
  assert.equal(chain.view(COLLECTION, 'nft_supply_for_owner', { account_id: ALICE }), '0');
});
