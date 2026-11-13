// Section D of the threat model: nothing a seller kept still opens the holder room.

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { test } from 'node:test';
import { base58encode, near } from '../tools/localnet/chain.mjs';
import { createLocal, COLLECTION } from '../server/local.mjs';
import { Refused, createRoom, nep413Hash } from '../server/room.mjs';
import { notesFor } from '../server/notes.mjs';

const MAYA = 'maya.testnet';
const SAM = 'sam.testnet';
const STRANGER = 'nobody.testnet';
const ONE_YOCTO = 1n;

function fixture() {
  const local = createLocal();
  const room = createRoom({ reader: local.reader(), notes: notesFor });
  const token = local.chain.view(COLLECTION, 'baton_of', { account_id: MAYA })[0].token_id;
  const enter = async (accountId, overrides = {}) => {
    const { nonce } = room.challenge();
    const signed = local.signMessage(accountId, { nonce });
    return room.enter({ tokenId: token, nonce, ...signed, ...overrides });
  };
  const sell = (from = MAYA, to = SAM) => assert.ok(local.chain.call(from, COLLECTION, 'nft_transfer', { receiver_id: to, token_id: token }, { deposit: ONE_YOCTO }).ok);
  return { local, room, token, enter, sell };
}

const refusedWith = (code) => (error) => {
  assert.ok(error instanceof Refused, `expected a refusal, got ${error}`);
  assert.equal(error.code, code);
  return true;
};

test('the current holder can open the room', async () => {
  const { room, token, enter } = fixture();
  const { session } = await enter(MAYA);
  const contents = await room.open(token, `Bearer ${session}`);
  assert.equal(contents.holder, MAYA);
  assert.ok(contents.notes.length > 0);
});

test('someone who does not hold it cannot open the room', async () => {
  const { room, token, enter } = fixture();
  await assert.rejects(enter(STRANGER), refusedWith('not_the_holder'));
  await assert.rejects(room.open(token, undefined), refusedWith('sign_in_first'));
  await assert.rejects(room.open(token, 'Bearer made-up'), refusedWith('sign_in_first'));
});

test('D1 session stops working after a sale', async () => {
  const { room, token, enter, sell } = fixture();
  const { session } = await enter(MAYA);
  assert.ok(await room.open(token, `Bearer ${session}`));
  sell();
  await assert.rejects(room.open(token, `Bearer ${session}`), (error) => {
    assert.equal(error.code, 'not_the_holder');
    assert.equal(error.detail.holder, SAM);
    return true;
  });
  const fresh = await enter(SAM);
  assert.equal((await room.open(token, `Bearer ${fresh.session}`)).holder, SAM);
});

test('D2 sign-in cannot be replayed', async () => {
  const { local, room, token, enter, sell } = fixture();
  const { nonce } = room.challenge();
  const signed = local.signMessage(MAYA, { nonce });
  await room.enter({ tokenId: token, nonce, ...signed });
  await assert.rejects(room.enter({ tokenId: token, nonce, ...signed }), refusedWith('nonce_unknown_or_used'), 'a nonce works once');
  await assert.rejects(room.enter({ tokenId: token, nonce: randomBytes(32).toString('base64'), ...signed }), refusedWith('nonce_unknown_or_used'), 'a nonce must come from the server');

  // A signature made before the sale, on a nonce still unused, does not get a seller back in.
  const { nonce: later } = room.challenge();
  const presigned = local.signMessage(MAYA, { nonce: later });
  sell();
  await assert.rejects(room.enter({ tokenId: token, nonce: later, ...presigned }), refusedWith('not_the_holder'));

  await assert.rejects(enter(MAYA), refusedWith('not_the_holder'));
});

test('D3 credential dies on transfer', async () => {
  const { room, token, enter, sell, local } = fixture();
  const { session } = await enter(MAYA);
  const { apiKey } = await room.issueCredential(token, `Bearer ${session}`);
  const answer = await room.rpc(apiKey, { method: 'status' });
  assert.equal(answer.result.chain_id, 'baton-local');
  assert.equal((await room.open(token, `Bearer ${session}`)).apiKey, apiKey);

  sell();
  await assert.rejects(room.rpc(apiKey, { method: 'status' }), refusedWith('key_died_with_the_sale'));

  // Selling it back does not revive the key: every transfer moves the rotation count forward.
  sell(SAM, MAYA);
  await assert.rejects(room.rpc(apiKey, { method: 'status' }), refusedWith('key_died_with_the_sale'));
  assert.ok(local.chain.view(COLLECTION, 'nft_token', { token_id: token }));
  await assert.rejects(room.rpc('baton_guess', {}), refusedWith('unknown_key'));
});

test('D4 key must belong to the account', async () => {
  const { room, token } = fixture();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const { nonce } = room.challenge();
  const signature = sign(null, nep413Hash({ nonce: Buffer.from(nonce, 'base64') }), privateKey).toString('base64');
  await assert.rejects(
    room.enter({ tokenId: token, accountId: MAYA, publicKey: `ed25519:${base58encode(raw)}`, signature, nonce }),
    refusedWith('key_not_on_account'),
    'a genuine signature from a key that is not on the account',
  );
});

test('a forged signature is refused', async () => {
  const { local, room, token } = fixture();
  const { nonce } = room.challenge();
  const signed = local.signMessage(MAYA, { nonce });
  const bad = Buffer.from(signed.signature, 'base64');
  bad[0] ^= 1;
  await assert.rejects(room.enter({ tokenId: token, nonce, ...signed, signature: bad.toString('base64') }), refusedWith('bad_signature'));
});

test('local demo seeds a market with listings and standing bids', () => {
  const { local } = fixture();
  const listings = local.chain.view(COLLECTION, 'baton_listings', {});
  assert.equal(listings.length, 3);
  assert.equal(listings.filter((l) => l.status === 'Unbonding').length, 2);
  assert.equal(local.chain.view(COLLECTION, 'baton_bids', {}).length, 2);
  const mayas = local.chain.view(COLLECTION, 'baton_of', { account_id: MAYA })[0];
  assert.ok(BigInt(mayas.baton.earned) > near('0.5'), 'time has passed and rewards have accrued');
});
