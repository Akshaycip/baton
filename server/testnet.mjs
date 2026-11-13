// Real testnet access for the server: reads for the holder room, and, for recording a demo,
// signing as this project's own demo accounts. Keys stay in the local NEAR keychain.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, actions } from 'near-api-js';

export const RPCS = (process.env.NEAR_RPC_URLS ?? 'https://rpc.testnet.fastnear.com,https://near-testnet.drpc.org,https://test.rpc.fastnear.com').split(',');
export const provider = new FailoverRpcProvider(RPCS.map((url) => new JsonRpcProvider({ url })));

/** Only Baton's own accounts may sign here, whatever else is in the local keychain. */
const OUR_ACCOUNTS = /^([a-z0-9-]+\.)*baton-[a-z0-9-]+\.testnet$/;

export function secretKeyOf(id) {
  if (!OUR_ACCOUNTS.test(id)) throw new Error(`${id} is not one of Baton's accounts`);
  const file = join(homedir(), '.near-credentials', 'testnet', `${id}.json`);
  return JSON.parse(readFileSync(file, 'utf8')).private_key;
}

export const accountOf = (id) => new Account(id, provider, KeyPairSigner.fromSecretKey(secretKeyOf(id)));
export { actions };

export async function view(accountId, method, args = {}, finality = 'final') {
  const result = await provider.query({
    request_type: 'call_function',
    finality,
    account_id: accountId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  return JSON.parse(Buffer.from(result.result).toString());
}

export async function accountInfo(id) {
  try {
    const [account, keys] = await Promise.all([
      provider.query({ request_type: 'view_account', finality: 'final', account_id: id }),
      provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: id }),
    ]);
    return {
      exists: true,
      balance: BigInt(account.amount).toString(),
      locked: BigInt(account.locked).toString(),
      codeHash: account.global_contract_hash ?? account.code_hash,
      keys: keys.keys.length,
    };
  } catch (error) {
    if (/does not exist|UnknownAccount/i.test(String(error?.message ?? error))) return { exists: false };
    throw error;
  }
}

/** Pulls the useful parts out of a transaction result, including every failure. */
export function outcomeOf(tx) {
  const receipts = tx.receipts_outcome ?? [];
  const logs = receipts.flatMap((r) => r.outcome.logs);
  const failures = receipts
    .map((r) => r.outcome.status?.Failure)
    .filter(Boolean)
    .map((failure) => ({ error: JSON.stringify(failure).slice(0, 300) }));
  const success = tx.status?.SuccessValue;
  let value;
  if (success !== undefined) {
    const text = Buffer.from(success, 'base64').toString();
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      value = text;
    }
  }
  const events = logs.filter((log) => log.startsWith('EVENT_JSON:')).map((log) => JSON.parse(log.slice('EVENT_JSON:'.length)));
  return {
    hash: tx.transaction_outcome?.id ?? tx.transaction?.hash,
    ok: success !== undefined,
    value,
    error: tx.status?.Failure ? JSON.stringify(tx.status.Failure).slice(0, 300) : undefined,
    failures,
    logs: logs.map((log) => ({ log })),
    events,
    gasBurnt: receipts.reduce((sum, r) => sum + r.outcome.gas_burnt, 0),
  };
}

export async function call(signerId, receiverId, method, args, { deposit = 0n, gas = 300n * 10n ** 12n } = {}) {
  const account = accountOf(signerId);
  const tx = await account.signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(method, args, gas, deposit)],
    waitUntil: 'FINAL',
    throwOnFailure: false,
  });
  return outcomeOf(tx);
}

export function testnetReader(collection) {
  return {
    async token(tokenId) {
      const found = await view(collection, 'baton_get', { token_id: tokenId });
      return found ? { owner: found.baton.owner, rotationSeq: found.baton.rotation_seq, pool: found.baton.pool } : null;
    },
    async keyPermission(accountId, publicKey) {
      try {
        const key = await provider.query({ request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
        return key.permission === 'FullAccess' ? 'FullAccess' : 'FunctionCall';
      } catch {
        return null;
      }
    },
    async rpc(body) {
      const response = await fetch(RPCS[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return response.json();
    },
  };
}
