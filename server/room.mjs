// The holder-only room: proof of holding, checked against the chain on every request.
//
// Signing in only proves who someone is. Access is decided by asking the chain who holds the token
// now, each time, so nothing a seller keeps from before the sale (a session, a signature, an API
// key) still opens anything afterwards.

import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

export const RECIPIENT = 'baton-holder-room';
export const MESSAGE = 'Open the Baton holder room';
const NONCE_TTL_MS = 5 * 60 * 1000;
const NEP413_TAG = 2147484061;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58decode(text) {
  let n = 0n;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(value);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const char of text) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const borshString = (text) => {
  const value = Buffer.from(text, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([length, value]);
};

/** The 32 bytes a NEP-413 wallet signs for this message. */
export function nep413Hash({ message = MESSAGE, nonce, recipient = RECIPIENT, callbackUrl = null }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const callback = callbackUrl === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), borshString(callbackUrl)]);
  return createHash('sha256')
    .update(Buffer.concat([tag, borshString(message), nonce, borshString(recipient), callback]))
    .digest();
}

export function verifyNep413({ publicKey, signature, nonce, message = MESSAGE, recipient = RECIPIENT }) {
  const [scheme, data] = publicKey.split(':');
  if (scheme !== 'ed25519' || !data) return false;
  const raw = base58decode(data);
  if (raw.length !== 32) return false;
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
  return verify(null, nep413Hash({ message, nonce, recipient }), key, Buffer.from(signature, 'base64'));
}

export class Refused extends Error {
  constructor(status, code, detail = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * `reader.token(tokenId)` returns `{ owner, rotationSeq, pool }` or null, read from the chain.
 * `reader.keyPermission(accountId, publicKey)` returns 'FullAccess', 'FunctionCall' or null.
 * `reader.rpc(body)` answers a JSON-RPC call for the holder's API credential.
 */
export function createRoom({ reader, notes = () => [], now = Date.now }) {
  const nonces = new Map();
  const sessions = new Map();
  const credentials = new Map();

  const sweep = () => {
    for (const [nonce, expires] of nonces) if (expires < now()) nonces.delete(nonce);
  };

  async function assertHolder(tokenId, accountId) {
    const token = await reader.token(tokenId);
    if (!token) throw new Refused(404, 'no_such_baton');
    if (token.owner !== accountId) throw new Refused(403, 'not_the_holder', { holder: token.owner });
    return token;
  }

  function sessionFrom(authorization, tokenId) {
    const id = /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
    const session = id ? sessions.get(id) : null;
    if (!session || session.tokenId !== tokenId) throw new Refused(401, 'sign_in_first');
    return session;
  }

  return {
    challenge() {
      sweep();
      const nonce = randomBytes(32).toString('base64');
      nonces.set(nonce, now() + NONCE_TTL_MS);
      return { nonce, message: MESSAGE, recipient: RECIPIENT };
    },

    async enter({ tokenId, accountId, publicKey, signature, nonce }) {
      const expires = nonces.get(nonce);
      if (!expires || expires < now()) throw new Refused(401, 'nonce_unknown_or_used');
      nonces.delete(nonce);

      const nonceBytes = Buffer.from(nonce, 'base64');
      if (nonceBytes.length !== 32) throw new Refused(400, 'bad_nonce');
      if (!verifyNep413({ publicKey, signature, nonce: nonceBytes })) throw new Refused(401, 'bad_signature');

      if ((await reader.keyPermission(accountId, publicKey)) !== 'FullAccess') throw new Refused(401, 'key_not_on_account');
      await assertHolder(tokenId, accountId);

      const session = randomBytes(24).toString('base64url');
      sessions.set(session, { tokenId, accountId });
      return { session };
    },

    /** The room's contents. The chain is asked who holds the token on every single request. */
    async open(tokenId, authorization) {
      const { accountId } = sessionFrom(authorization, tokenId);
      const token = await assertHolder(tokenId, accountId);
      const key = [...credentials].find(([, c]) => c.tokenId === tokenId && c.rotationSeq === token.rotationSeq)?.[0] ?? null;
      return { tokenId, holder: accountId, pool: token.pool, rotationSeq: token.rotationSeq, notes: notes(token.pool), apiKey: key };
    },

    /** A delegator API key. It carries the rotation count, which every transfer changes. */
    async issueCredential(tokenId, authorization) {
      const { accountId } = sessionFrom(authorization, tokenId);
      const token = await assertHolder(tokenId, accountId);
      const key = `baton_${randomBytes(18).toString('base64url')}`;
      credentials.set(key, { tokenId, rotationSeq: token.rotationSeq });
      return { apiKey: key };
    },

    async rpc(key, body) {
      const credential = credentials.get(key);
      if (!credential) throw new Refused(401, 'unknown_key');
      const token = await reader.token(credential.tokenId);
      if (!token || token.rotationSeq !== credential.rotationSeq) throw new Refused(403, 'key_died_with_the_sale', { holder: token?.owner });
      return reader.rpc(body);
    },
  };
}
