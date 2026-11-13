// Sets up the public testnet market: Batons at different stages and a standing offer.
//   node scripts/seed-testnet.mjs            first-time set-up
//   node scripts/seed-testnet.mjs reset      hands the film's Baton back to Maya and refills the offer
//
// Writes deployments/film.json with the token the film uses.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { accountInfo, call, view } from '../server/testnet.mjs';

const { collection: COLLECTION, pools } = JSON.parse(readFileSync('deployments/testnet.json', 'utf8'));
const MAYA = 'baton-maya.testnet';
const SAM = 'baton-sam.testnet';
const FILM = 'deployments/film.json';
const ONE_YOCTO = 1n;
const near = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 24n) / 1_000_000n;
const [STAKELY, , , NODE] = pools;

const act = async (label, signer, method, args, options = { deposit: ONE_YOCTO }) => {
  const result = await call(signer, COLLECTION, method, args, options);
  console.log(`${label}: ${result.hash}${result.failures.length ? ` FAILED ${JSON.stringify(result.failures)}` : ''} -> ${JSON.stringify(result.value)}`);
  if (!result.ok || result.value === false || result.failures.length) throw new Error(`${label} failed`);
  return result;
};
const mint = async (label, signer, amount, pool) => (await act(label, signer, 'baton_mint', { pool }, { deposit: near(amount + 0.06) })).events.find((e) => e.event === 'nft_mint').data[0].token_ids[0];
const balance = async (id) => Number(BigInt((await accountInfo(id)).balance) / 10n ** 21n) / 1000;

const OFFER = 4.6;
const OFFER_DISCOUNT = 25;

if (process.argv[2] === 'reset') {
  const film = JSON.parse(readFileSync(FILM, 'utf8'));
  const owner = (await view(COLLECTION, 'nft_token', { token_id: film.token })).owner_id;
  if (owner === SAM) await act('Sam gives the film Baton back', SAM, 'nft_transfer', { receiver_id: MAYA, token_id: film.token, memo: 'retake' });
  const open = (await view(COLLECTION, 'baton_bids')).filter((bid) => bid.bidder === SAM);
  for (const bid of open) await act('Sam closes an old offer', SAM, 'baton_bid_cancel', { bid_id: bid.id }, {});
  const { accountOf, actions } = await import('../server/testnet.mjs');
  const samHas = await balance(SAM);
  if (samHas < OFFER + 1) {
    const send = near(OFFER + 1 - samHas + 0.05);
    await accountOf(MAYA).signAndSendTransaction({ receiverId: SAM, actions: [actions.transfer(send)], waitUntil: 'FINAL' });
    console.log('Maya sent Sam', send.toString());
  }
  const placed = await act('Sam places the offer', SAM, 'baton_bid', { discount_bps: OFFER_DISCOUNT, max_epochs: 4 }, { deposit: near(OFFER + 0.005) });
  writeFileSync(FILM, `${JSON.stringify({ ...film, offer: placed.value }, null, 2)}\n`);
  console.log('Balances', await balance(MAYA), await balance(SAM));
  process.exit(0);
}

if (existsSync(FILM)) throw new Error(`${FILM} exists. Use "reset" for another take.`);

for (const bid of (await view(COLLECTION, 'baton_bids')).filter((b) => b.bidder === MAYA)) await act('Maya closes the test offer', MAYA, 'baton_bid_cancel', { bid_id: bid.id }, {});

// A real rollback on testnet: this receiver has no contract, so the token must come back by itself.
const e2eToken = `b1.${COLLECTION}`;
const bounced = await call(MAYA, COLLECTION, 'nft_transfer_call', { receiver_id: SAM, token_id: e2eToken, msg: '' }, { deposit: ONE_YOCTO });
console.log('transfer-call rollback:', bounced.hash, 'returned', bounced.value, 'holder', (await view(COLLECTION, 'nft_token', { token_id: e2eToken })).owner_id);

const token = await mint("Maya's stake", MAYA, 4, STAKELY);
const placed = await act("Sam's standing offer", SAM, 'baton_bid', { discount_bps: OFFER_DISCOUNT, max_epochs: 4 }, { deposit: near(OFFER + 0.005) });
const other = await mint('Another stake', SAM, 1.1, NODE);

await act('List the other stake', SAM, 'baton_list', { token_id: other, price: near(1.09).toString() });
await act('List the Baton that is unstaking', MAYA, 'baton_list', { token_id: e2eToken, price: near(1.995).toString() });

writeFileSync(FILM, `${JSON.stringify({ token, offer: placed.value, other, unstaking: e2eToken }, null, 2)}\n`);
console.log('Wrote', FILM, 'Balances', await balance(MAYA), await balance(SAM));
