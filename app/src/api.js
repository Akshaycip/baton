// One data layer for both ways of running: a server-side signer (the practice chain, or demo
// accounts on testnet) and a real wallet on testnet.

import { NearConnector } from '@hot-labs/near-connect';

export const GAS = { HIGH: '300000000000000', MID: '150000000000000', LOW: '60000000000000' };
export const ONE_YOCTO = '1';

let config = null;
let connector = null;

export async function loadConfig() {
  config = await (await fetch('./config.json', { cache: 'no-store' })).json();
  if (config.signer === 'wallet') connector = new NearConnector({ network: config.network });
  return config;
}

export const getConfig = () => config;
export const collection = () => config.collection;
export const canSkipTime = () => config.mode === 'local';
const usesServer = () => config.signer === 'server';
export const roomApi = () => config.roomApi ?? '';

async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), data, { status: response.status });
  return data;
}

async function rpc(method, params) {
  let last;
  for (const url of config.rpc) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'baton', method, params }) });
      const data = await response.json();
      if (data.error) throw new Error(data.error.data ?? data.error.message);
      if (data.result?.error) throw new Error(data.result.error);
      return data.result;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

export async function view(account, method, args = {}) {
  if (usesServer()) return (await post('/local/view', { account, method, args })).value;
  const result = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result)));
}

export async function accountInfo(id) {
  if (usesServer()) return post('/local/account', { id });
  try {
    const [account, keys] = await Promise.all([
      rpc('query', { request_type: 'view_account', finality: 'final', account_id: id }),
      rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: id }),
    ]);
    return { exists: true, balance: account.amount, locked: account.locked, codeHash: account.global_contract_hash ?? account.code_hash, keys: keys.keys.length };
  } catch (error) {
    if (/does not exist|UnknownAccount/i.test(error.message)) return { exists: false };
    throw error;
  }
}

function outcome(tx) {
  const receipts = tx.receipts_outcome ?? [];
  const success = tx.status?.SuccessValue;
  let value;
  if (success !== undefined && success !== '') {
    try {
      value = JSON.parse(atob(success));
    } catch {
      value = atob(success);
    }
  }
  const failures = receipts.map((r) => r.outcome.status?.Failure).filter(Boolean).map((failure) => ({ error: JSON.stringify(failure) }));
  const events = receipts.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)));
  return { hash: tx.transaction_outcome?.id, ok: success !== undefined, value, failures, events, error: tx.status?.Failure ? JSON.stringify(tx.status.Failure) : undefined };
}

export async function send(user, receiver, method, args, { deposit = '0', gas = GAS.HIGH } = {}) {
  if (usesServer()) return post('/local/call', { persona: user, receiver, method, args, deposit, gas });
  const wallet = await connector.wallet();
  const tx = await wallet.signAndSendTransaction({
    receiverId: receiver,
    actions: [{ type: 'FunctionCall', params: { methodName: method, args, gas, deposit } }],
  });
  return outcome(tx);
}

export const act = (user, method, args, options) => send(user, config.collection, method, args, options);

/** Reads what the chain says right now about a position, straight from the pool and the vault. */
export async function livePosition(tokenId, pool) {
  const [account, liquid] = await Promise.all([view(pool, 'get_account', { account_id: tokenId }), view(tokenId, 'liquid', {})]);
  return { staked: BigInt(account.staked_balance), unstaked: BigInt(account.unstaked_balance), canWithdraw: account.can_withdraw, liquid: BigInt(liquid) };
}

export const skipEpochs = (epochs) => post('/local/skip', { epochs });
export const resetLocal = () => post('/local/reset');

// ---- wallets ----

export async function connectWallet() {
  await connector.connect();
  const wallet = await connector.wallet();
  const [account] = await wallet.getAccounts();
  return account?.accountId ?? null;
}

export async function restoreWallet() {
  if (!connector) return null;
  try {
    const wallet = await connector.wallet();
    const [account] = await wallet.getAccounts();
    return account?.accountId ?? null;
  } catch {
    return null;
  }
}

export const disconnectWallet = () => connector?.disconnect();

/** Some wallets finish signing in after the first call has returned, so follow their events too. */
export function onWalletChange(callback) {
  if (!connector) return () => {};
  const signedIn = ({ accounts }) => callback(accounts?.[0]?.accountId ?? null);
  const signedOut = () => callback(null);
  connector.on('wallet:signIn', signedIn);
  connector.on('wallet:signOut', signedOut);
  return () => {
    connector.off('wallet:signIn', signedIn);
    connector.off('wallet:signOut', signedOut);
  };
}

// ---- the holder room ----

const roomUrl = (path) => `${roomApi()}${path}`;

async function roomCall(path, options = {}) {
  const response = await fetch(roomUrl(path), options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? 'Refused'), data, { status: response.status });
  return data;
}

export async function enterRoom(user, tokenId) {
  const { nonce, message, recipient } = await roomCall('/api/room/challenge', { method: 'POST' });
  let signed;
  if (usesServer()) {
    signed = await post('/local/sign', { persona: user, nonce });
  } else {
    const wallet = await connector.wallet();
    signed = await wallet.signMessage({ message, recipient, nonce: Uint8Array.from(atob(nonce), (c) => c.charCodeAt(0)) });
  }
  const { session } = await roomCall('/api/room/enter', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokenId, accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce }),
  });
  return session;
}

const bearer = (session) => ({ authorization: `Bearer ${session}` });
export const openRoom = (tokenId, session) => roomCall(`/api/room/${tokenId}`, { headers: bearer(session) });
export const issueKey = (tokenId, session) => roomCall(`/api/room/${tokenId}/credential`, { method: 'POST', headers: bearer(session) });
export const useKey = (key) =>
  roomCall(`/rpc/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'baton', method: 'status', params: [] }) });
