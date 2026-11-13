# Baton threat model

**Every way a seller could try to keep the money, and what stops it.**

The track requires this document before any contract code. It was written first. Each row names
the defence and the test that proves it, so a reader can check the claim instead of trusting it.

## What is being sold

A Baton is one NEP-171 token bound to one NEAR sub-account, its **vault**. The vault is an ordinary
delegator at an unmodified validator staking pool. Whoever holds the token controls what the vault
does. A buyer is paying for:

| Part of the position | Where it lives |
| --- | --- |
| Staked NEAR and the rewards it keeps earning | Staking pool, under the vault's account |
| Unbonding NEAR, with its remaining wait | Staking pool, under the vault's account |
| Liquid NEAR, ready to claim | The vault's own balance |
| The right to open the holder-only room | Checked live against the token's owner |

## How control works

```text
 holder ──► collection (title registry) ──► vault (keyless account) ──► staking pool
              decides who may act            obeys only the collection     sees one delegator
```

1. The collection creates each vault in one batch: create account, fund it, attach immutable code
   by hash, initialise. The batch has no `AddKey`, so the vault has **zero access keys from its
   first block**.
2. The vault accepts instructions only from its parent, the collection.
3. The collection accepts instructions only from the token's current owner.
4. Ownership is one entry in the collection. Changing it needs no key rotation, so there is no
   window where the old and new owner both hold a key.

## Assumptions

- The NEAR runtime behaves as documented: a sub-account can only be created by its parent, and a
  callback runs even when the call before it failed.
- The staking pool code from the official factory behaves as published. The vault tests run the
  exact bytes deployed on testnet.
- The collection's access keys are removed after deployment. Until that happens, the deployer is
  trusted. On testnet this is done: `baton-relay.testnet` has zero keys. `npm run verify:testnet`
  and the app's Check it yourself page both read the key count, so anyone can confirm it.

## A. Keep a way into the account

| # | Attack | What stops it | Test |
| --- | --- | --- | --- |
| A1 | Mint with a hidden key on the vault, keep it after the sale | Creation batch has no `AddKey`. Vault has zero keys from birth. Anyone can read `view_access_key_list` | `A1 vault has no access keys` |
| A2 | Add a key later through vault code | The vault wasm does not import any add-key host function. The test parses its import table | `A2 A3 vault wasm cannot add keys or deploy` |
| A3 | Replace the vault's code with a backdoor | Same import check for deploy. Code is referenced by hash, which cannot be repointed. No upgrade method exists | `A2 A3 vault wasm cannot add keys or deploy` |
| A4 | Call the vault directly | Every vault method requires the predecessor to be the collection | `A4 only the collection can instruct a vault` |
| A5 | Forge a callback to the collection or vault | All callbacks are private: the predecessor must be the contract itself | `A5 callbacks cannot be forged` |
| A6 | Use an admin path on the collection | The collection has no owner, no admin method, no upgrade method | `A6 collection has no admin surface` |
| A7 | Pass off an outside account as a vault | Token ids are sub-accounts created by the collection. Only a parent can create its sub-accounts | `A7 token ids are the collection's own sub-accounts` |

## B. Pull the money out around the sale

NEAR calls are asynchronous: a payout takes several receipts across several blocks, and another
transaction can land between them. This section is where a naive design loses money.

| # | Attack | What stops it | Test |
| --- | --- | --- | --- |
| B1 | **Sale in the middle of a payout.** Start a claim, sell while the transfer is in flight, collect both | A per-token lock is set in the same receipt that starts the claim. Sale and transfer refuse while it is held | `B1 sale during a payout is refused` |
| B2 | Sell while a pool withdrawal is in flight | Same lock | `B2 sale during a pool withdrawal is refused` |
| B3 | Sell while an unstake is in flight | Same lock | `B3 sale during an unstake is refused` |
| B4 | Sell first, then claim as the old owner | The collection checks the current owner when the claim arrives | `B4 old owner is refused after a sale` |
| B5 | Have a payout resolve to the old owner after the sale | Not reachable: the recipient is fixed while the lock is held, and no sale can complete until the payout has settled | `B5 payout goes to the holder at request time` |
| B6 | Claim everything between listing and sale | Any operation deletes the listing. The buyer's call names the listing id, so it fails | `B6 any operation voids the listing` |
| B7 | `nft_transfer_call` to a contract that drains the vault while it holds the token, then returns "reject" so the token rolls back | The lock is held from the transfer until `nft_resolve_transfer`, so the temporary holder cannot act | `B7 transfer-call receiver cannot drain` |
| B8 | Leave an approval behind and take the token back after the sale | NEP-178 approvals are not offered. `approval_id` must be empty | `B8 approvals are refused` |
| B9 | Move stake to a colluding pool | The pool is pinned in the vault at creation and cannot change | `B9 pool is pinned` |
| B10 | Delete the vault and send its balance elsewhere | There is no close method, and the vault wasm does not import the delete-account host function | `A2 A3 vault wasm cannot add keys or deploy` |

## C. Mislead the buyer about what they are getting

| # | Attack | What stops it | Test |
| --- | --- | --- | --- |
| C1 | **Fake pool.** Deploy a contract that reports 10,000 NEAR staked, mint against it, sell it | A pool must be a sub-account of the official factory (`.poolv1.near`, testnet `.pool.f863973.m0`). The factory has no keys and only creates audited pool code | `C1 fake pools are refused` |
| C2 | **Reset the unbonding clock.** Staking pools restart the wait for the whole unstaked balance on any new unstake. Unstake 1 yocto just before the sale, so "ready soon" becomes 4 more epochs | Any operation deletes the listing and the listing id check fails | `C2 resetting the unbonding clock voids the listing` |
| C3 | Raise the price while the buyer's transaction is in flight | Every listing has a new id. The buyer's call names the id they saw | `C3 price change cannot catch a buyer` |
| C4 | Move the token to a second wallet and sell a stale listing | A transfer deletes the listing | `C4 transfer voids the listing` |
| C5 | List during an operation so the snapshot is wrong | Listing refuses while locked, and holds the lock during its own snapshot | `C5 cannot list mid-operation` |
| C6 | Change the position while a listing's snapshot is being taken | Same lock | `C5 cannot list mid-operation` |
| C7 | Fake the history | History is written only by the collection, in its own state, and read straight from it | `C7 history records earned, paid and holders` |

Rewards that arrive between the listing and the sale go to the buyer. Commission changes and
validator downtime are ordinary delegation risks. The app shows the pool's current commission.

## D. Keep something other than the money

| # | Attack | What stops it | Test |
| --- | --- | --- | --- |
| D1 | Keep using a room session after selling | Every request re-reads the token's owner from the chain | `D1 session stops working after a sale` |
| D2 | Replay an old signed sign-in after selling | The signature only proves who signed. Access still needs that account to own the token now. Nonces are single-use | `D2 sign-in cannot be replayed` |
| D3 | Keep the holder's API credential after selling | The credential is bound to the token and its rotation count, which changes on every transfer | `D3 credential dies on transfer` |
| D4 | Sign in with a key that is not on the account | The server checks that the public key is a full-access key of that account | `D4 key must belong to the account` |

## E. Grief the holder or buyer

| # | Attack | What stops it | Test |
| --- | --- | --- | --- |
| E1 | Leave a token locked forever | Callbacks run even after failures, and reset the lock. A permissionless unstick exists after a long timeout | `E1 failed operation releases the lock`, `E2 stuck lock can be released after the timeout` |
| E3 | Spam snapshots to keep a token locked so it cannot sell | Public `sync` takes no lock. Its result is dropped if the position changed meanwhile | `E3 sync takes no lock` |
| E4 | Grow history until storage runs out and operations fail | History is a capped ring, funded at mint | `E4 history stays within its cap` |
| E5 | A seller account that cannot receive the proceeds | The sale still completes. Proceeds wait in a claimable balance | `E5 bounced proceeds stay claimable` |

## F. Attacks on the seller or standing bidder

| # | Attack | What stops it | Test |
| --- | --- | --- | --- |
| F1 | Pay less than the price | Deposit must cover the listing price. Extra is refunded | `F1 underpayment fails and overpayment is refunded` |
| F2 | Cancel a standing bid while it is being filled | Fill re-checks the bid after its snapshot and releases the lock if it is gone. Nothing moves | `F2 cancelled bid fails cleanly` |
| F3 | Fill a bid at a value the seller did not expect | The seller passes a minimum price | `F3 fill honours the minimum price` |
| F4 | Fill a bid with a position slower than the bidder allowed | Fill checks epochs remaining against the bid's limit | `F4 fill honours the epoch limit` |

## Residual risk

These are not eliminated, and the README says so.

- **Validator risk.** Commission can change and validators can go offline. That reduces rewards.
- **Collection code risk.** A bug in the collection affects every Baton. It holds title and standing
  bids, but not staked funds.
- **Pool factory.** The check trusts the official factory and its code.
- **Unaudited.** This is hackathon software and has not had an external audit.
