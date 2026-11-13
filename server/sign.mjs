// NEP-413 signing with a demo account's key, for the no-wallet recording mode.

import { KeyPair } from 'near-api-js';
import { nep413Hash } from './room.mjs';

export function signNep413(secretKey, accountId, nonce) {
  const pair = KeyPair.fromString(secretKey);
  const { signature } = pair.sign(nep413Hash({ nonce: Buffer.from(nonce, 'base64') }));
  return { accountId, publicKey: pair.getPublicKey().toString(), signature: Buffer.from(signature).toString('base64') };
}
