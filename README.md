# Baton

An NFT that is a live NEAR stake. Each Baton is a NEP-171 token and also a real NEAR account delegating at an unmodified validator staking pool. Selling the NFT sells the stake, with no unstaking.

Track: NFTs That Do Something. Demo video: [video/baton-demo.mp4](video/baton-demo.mp4), 1:34, filmed on testnet.

## The problem

Native NEAR staking has no exit except unstaking. The staking pool contract holds unstaked NEAR until the fourth epoch after the unstake, which is up to 28 hours (epochs are 43,200 blocks, measured at 0.57 s per block on mainnet and 0.58 s on testnet). During that time the holder has no access to the NEAR and carries the price risk, and the validator loses the stake, which can cost it its seat.

Liquid staking tokens solve the wait by moving stake into a shared pool whose operator picks the validators. A delegator who wants to choose their own validator has no liquid option.

## What Baton does

- **Stake through an NFT.** Pick any validator from the official pool factory. Baton creates a new sub-account with no access keys, delegates from it, and issues an NFT that controls it.
- **Sell without unstaking.** List it, or sell instantly into a standing offer. Title moves in one transaction. The validator's total stake does not change.
- **Sell NEAR that is already unstaking.** A position 2 epochs from unlocking can be sold now. The buyer waits out the rest and keeps the discount.
- **Holder-only room.** A page and API key that work only for the current holder, checked against the chain on every request.
- **A record that travels with it.** Each NFT stores who held it, what they paid, what it earned and what it paid out. Its picture is drawn on-chain from live state.

It needs no change to NEAR, no change to any validator, and no opt-in from anyone: to a staking pool, a vault is one more delegator.

## Check it in five minutes

No wallet, no test NEAR. Needs Node 22 or newer. The compiled contracts are in `res/`, so Rust is not needed for these steps.

```bash
npm install
```

| Do | See |
| --- | --- |
| `npm test` | 62 tests pass. They run the compiled contracts against the exact staking pool bytes deployed on testnet (`tests/fixtures/staking_pool_testnet.wasm`, the code of `01node.pool.f863973.m0`, hash `J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY`). |
| `npm run story` | A sale from start to finish in the terminal, read back from the chain at each step. Exits non-zero if anything differs. |
| `npm run verify:testnet` | 12 read-only checks against the live testnet deployment, with no keys needed: the collection and vault have no keys, their code matches `res/`, the validator really holds the stake, the account and NFT name the same holder. |
| `npm run demo`, then open http://localhost:8787 | The app on a private practice chain, with sample data. Use **You are** at the top right to switch people, and **Skip 7 hours** or **Skip 30 days** to move time. |

Then in the app:

| Do | See |
| --- | --- |
| As Maya, open My Batons and pick the Baton | 120 NEAR staked, some earned, a picture with one lane |
| Click Holder room, then Sign to enter, then Create my key, then Test the key | The room opens and the key answers |
| Go back and click **Exit now** | Maya is paid immediately. Sam is the holder. The stake is still at the validator |
| Open Holder room again as Maya, click Try my old key | Refused: the room belongs to Sam and the key returns 403 `key_died_with_the_sale` |
| Switch to Sam, open the room, sign | The room opens for Sam |
| Click Check it yourself on the Baton | Six live checks: no keys, code hash, stake at the validator, official pool, the account and NFT agree, no admin |

To rebuild the contracts from source, install Rust and cargo-near, then run `npm run build:contracts`. The toolchain is pinned in `rust-toolchain.toml`.

## How control passes on transfer

```text
 holder ──► collection (title registry) ──► vault (keyless account) ──► staking pool
              decides who may act            obeys only the collection     sees one delegator
```

1. `contracts/collection` keeps who holds each token. `contracts/vault` is the account that holds the stake.
2. The collection creates each vault in one batch: create account, fund, attach code by hash, initialise. There is no `AddKey`, so the vault has zero access keys from its first block.
3. A vault accepts orders only from its parent account, the collection. `only_collection` checks the predecessor on every order.
4. The collection accepts orders only from the token's current owner, so changing the owner in the collection changes who controls the vault. Nothing has to be rotated, and no moment exists when two parties hold a key.

### What stops the old owner keeping access

| A seller might try | Why it fails |
| --- | --- |
| Keep a key to the account | There never was one. Anyone can run `near account list-keys` on a vault |
| Add a key or swap the code later | The vault's wasm imports no host function that can add a key, delete one, deploy code, create an account or delete itself. `A2 A3 vault wasm cannot add keys or deploy` parses the import table and fails if that changes |
| Call the vault directly | Refused: only the parent may instruct it |
| Use an admin path | The collection has no owner, admin or upgrade method. Its keys are removed after deployment |
| Keep an NFT approval | NEP-178 approvals are not offered, so there are none to leave behind |
| Keep a room session or API key | The room asks the chain who holds the token on every request. API keys are bound to the rotation count, which every transfer changes |

### A sale in the middle of a payout

NEAR calls take several receipts across several blocks, and another transaction can land between them. A naive contract would let a seller start a payout, sell while it is in flight, and collect both.

Every operation that moves money takes a per-token lock in the same receipt that starts it. Sale and transfer refuse while the lock is held, and a callback that the runtime runs even after failures releases it. `tests/races.test.mjs` stops the chain between receipts and lands the second transaction exactly where an attacker would.

Other cases that test covers: `nft_transfer_call` to a contract that drains the vault and then rejects the token; a seller who restarts the unbonding clock just before a sale (the pool resets the wait for the whole balance on any new unstake); a fake pool that reports invented balances; a price change while a buyer's transaction is in flight.

The full list, each attack with its defence and test name: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). It was written before any contract code, as the track asks.

To confirm the tests do catch these, each defence was removed in turn and the suite rerun: all 17 mutants were caught by a matching test.

## Standards

| Standard | Where |
| --- | --- |
| NEP-171 core, including `nft_transfer_call` | `contracts/collection/src/nft.rs` |
| NEP-177 metadata, with media generated on-chain | `contracts/collection/src/render.rs` |
| NEP-181 enumeration | `contracts/collection/src/nft.rs` |
| NEP-297 events | `contracts/collection/src/lib.rs` |
| NEP-413 signed messages | `server/room.mjs` |
| NEP-591 global contract by hash, for the vault | `contracts/collection/src/ops.rs` |
| Sharded NFT Items draft: `nft_item_info`, `config_epoch` | `contracts/vault/src/lib.rs` |

Two deliberate departures. NEP-178 approvals are refused, because a third-party market cannot honour the listing rules. And in the Sharded Items draft the item is the authority, while here the collection is: the vault mirrors the owner for the pair check (the app's sixth proof runs it) but never uses it to authorise anything. The vault therefore always reports `Active`, even while the collection holds a lock.

## What it costs

| Item | Amount |
| --- | --- |
| Publishing the vault code, once | About 4.5 NEAR (45 KB, global contract) |
| Each new Baton | 0.06 NEAR on top of the stake: 0.01 for the vault account, 0.05 for its capped record |
| Sale fee | 0.1%, fixed at deployment |
| Standing offer | 0.005 NEAR storage, returned when it closes |

## Live on testnet

| What | Where |
| --- | --- |
| Collection, with zero access keys | [`baton-relay.testnet`](https://testnet.nearblocks.io/address/baton-relay.testnet) |
| Vault code, published by hash | `GTCaiS2wo5rzWD7CyZSDvyRTzCDFmRK6itVW32Dugddo` |
| A Baton that was sold, staked at a live validator | [`b2.baton-relay.testnet`](https://testnet.nearblocks.io/address/b2.baton-relay.testnet) |
| That sale, in one transaction | [`BVSyLodDXPZQ3e7VNGSFw8TxhVesnNT6B8PP3SMCsLWp`](https://testnet.nearblocks.io/txns/BVSyLodDXPZQ3e7VNGSFw8TxhVesnNT6B8PP3SMCsLWp) |

In that sale the seller's balance went from 3.85 to 7.83 NEAR, and the validator's total stake read 13,970,440.693 NEAR before and after.

Gas measured on testnet for a Baton delegating to `stakely_v2.pool.f863973.m0`. The transactions are in `deployments/e2e.json`.

| Action | TGas burnt |
| --- | --- |
| Mint, including creating the account and staking | 33 |
| List | 9 |
| Buy | 8 |
| Place a standing offer | 2 |
| Sell into an offer | 15 |
| Unstake | 20 |
| Withdraw, after the 4-epoch wait | 12 |
| Claim to the holder's wallet | 9 |

The whole life of a Baton has run on testnet: mint, list, buy, sell into an offer, a refused attempt by the old holder, a rolled-back `nft_transfer_call`, unstake, and after the wait, withdraw and claim. The claim paid the holder the full 2 NEAR.

To run the app against testnet with a real wallet, `node server/index.mjs --testnet` after `npm run build:app`. The holder room needs that small server. It is the only off-chain part, and it holds nothing that controls money.

## Limits

- Unaudited hackathon software.
- A position holds one validator for life. To change validator, unstake, claim and start a new Baton.
- Existing delegations cannot move in. A delegator has to unstake once and restake through a Baton.
- Validators can change commission or go offline. The app shows the current commission.
- The practice chain does not model gas burnt or shards. Static gas budgets are checked for fit, and real usage is measured on testnet (table above).
- The wallet selector and read paths have been run against testnet. Automated runs sign with the demo accounts, so signing through a real wallet app has not been tested end to end.
- History is capped at 12 holders and 24 entries per Baton. The first holder is always kept, and every event remains in the chain's logs.
- `npm run demo` uses sample data, including the validator notices in the holder room.

## Layout

```text
contracts/vault       One Baton's account. Under 200 lines
contracts/collection  Title registry, lock, books, market, on-chain art
server/               App server and the holder room
app/                  React front end
tools/localnet        NEAR host that runs compiled wasm in Node
tests/                Lifecycle, race, market, proof and room tests
scripts/              Build, deploy, lock, seed, end-to-end and live verification
deployments/          What is live on testnet, and measured gas
docs/THREAT_MODEL.md  Every attack, its defence and its test
docs/DEMO.md          The demo film: what it shows, how it was made, and the X post
tools/video           How the demo film was made
```

## Disclosures

- **Built during the hackathon window.** No code predates it.
- **No version on another chain.**
- **Libraries:** near-sdk, near-api-js, React, react-router, Vite, @hot-labs/near-connect, Archivo and IBM Plex Mono fonts.
- **Fixture:** `tests/fixtures/staking_pool_testnet.wasm` is the unmodified official staking pool, downloaded from testnet.
- **Adapted code:** `tools/localnet/chain.mjs`, `tools/video/` and `scripts/upload-site.mjs` are adapted from the author's own tooling, written during the hackathon window and MIT licensed. Everything else here was written for Baton.
- **Demo film:** filmed on real testnet with `tools/video/record.mjs`. The demo accounts sign without a wallet popup, and the transactions are real. The people are fictional and their voices are generated by Orpheus, an open text-to-speech model.
- **AI assistance:** the code and documents here were written with Claude Code.

MIT licensed.
