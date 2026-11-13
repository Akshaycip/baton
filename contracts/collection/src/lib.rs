//! The Baton collection: title registry and market.
//!
//! Each token is one vault, a keyless sub-account delegating at a staking pool. This contract is
//! the only thing a vault obeys, and it obeys only the token's current owner.
//!
//! The rule that matters: NEAR calls are asynchronous, so another transaction can land between the
//! steps of a payout. Every operation that moves money takes a per-token lock in the same receipt
//! that starts it, and the token cannot change hands until that operation's callback releases it.
//! See `docs/THREAT_MODEL.md`.
//!
//! There is no owner, admin or upgrade method here. Configuration is set once, at deployment.

mod market;
mod nft;
mod ops;
mod render;
mod types;

use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, ext_contract, near, require, serde_json, AccountId, BorshStorageKey, CryptoHash, Gas, PanicOnDefault, Promise};

pub use types::*;

pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// Must match `RESERVE` in the vault. Keeps the vault account alive.
pub const VAULT_RESERVE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
/// Pays for this contract's bounded record of the token.
pub const TOKEN_STORAGE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
pub const MIN_STAKE: u128 = ONE_NEAR;
pub const MIN_TOP_UP: u128 = ONE_NEAR / 10;
pub const BID_STORAGE: u128 = 5_000_000_000_000_000_000_000; // 0.005 NEAR
/// A bid with less than this left is closed and returned.
pub const MIN_BID_REMAINING: u128 = ONE_NEAR / 10;

/// `NUM_EPOCHS_TO_UNLOCK` in the staking pool contract.
pub const UNBONDING_EPOCHS: u64 = 4;
/// How long a lock must be stuck before anyone may release it.
pub const UNSTICK_AFTER_BLOCKS: u64 = 7_200;

pub const MAX_LEGS: usize = 12;
pub const MAX_LOG: usize = 24;
pub const MAX_TOKENS_PER_OWNER: usize = 128;
pub const MAX_FEE_BPS: u16 = 100;

pub const GAS_VAULT_INIT: Gas = Gas::from_tgas(10);
/// The pool call and its report back, reserved inside the vault.
pub const GAS_VAULT_POOL_OP: Gas = Gas::from_tgas(85);
pub const GAS_VAULT_PAY: Gas = Gas::from_tgas(10);
pub const GAS_ROTATE: Gas = Gas::from_tgas(5);
pub const GAS_POOL_VIEW: Gas = Gas::from_tgas(10);
pub const GAS_VAULT_VIEW: Gas = Gas::from_tgas(3);
pub const GAS_ON_SNAPSHOT: Gas = Gas::from_tgas(30);
/// Everything a callback needs to take a snapshot afterwards, with room for its own work.
pub const GAS_AFTER_OP: Gas = Gas::from_tgas(10 + 10 + 3 + 30);
/// Generous on purpose. If this callback could not run, a new vault would have no token.
pub const GAS_ON_MINTED: Gas = Gas::from_tgas(20 + 85 + 53);
pub const GAS_ON_CLAIMED: Gas = Gas::from_tgas(10);
pub const GAS_ON_PROCEEDS: Gas = Gas::from_tgas(5);
pub const GAS_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Batons,
    Owners,
    Listings,
    Bids,
    Refunds,
}

#[ext_contract(ext_vault)]
pub trait ExtVault {
    fn stake(&mut self, #[serializer(borsh)] amount: u128) -> bool;
    fn unstake(&self, #[serializer(borsh)] amount: Option<u128>) -> bool;
    fn withdraw(&self) -> bool;
    fn pay(&self, #[serializer(borsh)] to: AccountId, #[serializer(borsh)] amount: Option<u128>) -> U128;
    fn rotate(&mut self, #[serializer(borsh)] owner: AccountId, #[serializer(borsh)] seq: u64);
    fn liquid(&self) -> U128;
}

#[ext_contract(ext_pool)]
pub trait ExtPool {
    fn get_account(&self, account_id: AccountId) -> PoolAccount;
}

#[ext_contract(ext_receiver)]
pub trait ExtReceiver {
    fn nft_on_transfer(&mut self, sender_id: AccountId, previous_owner_id: AccountId, token_id: TokenId, msg: String) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Collection {
    vault_code: CryptoHash,
    pool_suffix: String,
    fee_bps: u16,
    treasury: AccountId,
    next_id: u64,
    next_lock: u64,
    next_listing: u64,
    next_bid: u64,
    batons: IterableMap<TokenId, Baton>,
    owners: LookupMap<AccountId, Vec<TokenId>>,
    listings: IterableMap<TokenId, Listing>,
    bids: IterableMap<u64, Bid>,
    refunds: LookupMap<AccountId, u128>,
}

#[near]
impl Collection {
    /// One-time setup. `pool_suffix` is the official pool factory, with its leading dot:
    /// `.poolv1.near` on mainnet and `.pool.f863973.m0` on testnet.
    #[init]
    pub fn new(vault_code_hash: Base58CryptoHash, pool_suffix: String, fee_bps: u16, treasury: AccountId) -> Self {
        require!(pool_suffix.starts_with('.'), "pool_suffix must start with a dot");
        require!(fee_bps <= MAX_FEE_BPS, "Fee is too high");
        Self {
            vault_code: vault_code_hash.into(),
            pool_suffix,
            fee_bps,
            treasury,
            next_id: 1,
            next_lock: 1,
            next_listing: 1,
            next_bid: 1,
            batons: IterableMap::new(Key::Batons),
            owners: LookupMap::new(Key::Owners),
            listings: IterableMap::new(Key::Listings),
            bids: IterableMap::new(Key::Bids),
            refunds: LookupMap::new(Key::Refunds),
        }
    }

    pub fn baton_get(&self, token_id: TokenId) -> Option<BatonView> {
        let baton = self.batons.get(&token_id)?.clone();
        let epoch = env::epoch_height();
        Some(BatonView {
            status: render::status(&baton, epoch).0.to_string(),
            epoch: U64(epoch),
            epochs_left: U64(render::epochs_left(&baton, epoch)),
            listing: self.listings.get(&token_id).cloned(),
            token_id,
            baton,
        })
    }

    pub fn baton_listings(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<BatonView> {
        self.listings
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|(id, _)| self.baton_get(id.clone()))
            .collect()
    }

    pub fn baton_bids(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Bid> {
        self.bids
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(_, bid)| bid.clone())
            .collect()
    }

    pub fn baton_of(&self, account_id: AccountId) -> Vec<BatonView> {
        self.owners
            .get(&account_id)
            .map(|ids| ids.iter().filter_map(|id| self.baton_get(id.clone())).collect())
            .unwrap_or_default()
    }

    pub fn baton_all(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<BatonView> {
        self.batons
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|(id, _)| self.baton_get(id.clone()))
            .collect()
    }

    /// NEAR that could not be delivered and is waiting for this account.
    pub fn baton_pending_refund(&self, account_id: AccountId) -> U128 {
        U128(self.refunds.get(&account_id).copied().unwrap_or(0))
    }

    pub fn baton_config(&self) -> Config {
        Config {
            vault_code_hash: self.vault_code.into(),
            pool_suffix: self.pool_suffix.clone(),
            fee_bps: self.fee_bps,
            treasury: self.treasury.clone(),
            min_stake: U128(MIN_STAKE),
            mint_overhead: U128(VAULT_RESERVE + TOKEN_STORAGE),
            bid_overhead: U128(BID_STORAGE),
            unbonding_epochs: U64(UNBONDING_EPOCHS),
            unstick_after_blocks: U64(UNSTICK_AFTER_BLOCKS),
        }
    }

    /// Sharded NFT Items draft. Constant, because nothing here can change after deployment.
    pub fn config_epoch(&self) -> u32 {
        1
    }
}

impl Collection {
    pub(crate) fn baton(&self, token_id: &TokenId) -> Baton {
        self.batons.get(token_id).cloned().unwrap_or_else(|| env::panic_str("No such Baton"))
    }

    pub(crate) fn save(&mut self, token_id: &TokenId, baton: Baton) {
        self.batons.insert(token_id.clone(), baton);
    }

    /// The gate every holder action passes through: right caller, nothing in flight.
    pub(crate) fn holder_baton(&self, token_id: &TokenId) -> Baton {
        let baton = self.baton(token_id);
        require!(baton.owner == env::predecessor_account_id(), "Only the current holder can do this");
        require!(baton.lock.is_none(), "This Baton is mid-operation");
        baton
    }

    /// Takes the lock and voids any listing, because what was offered is about to change.
    pub(crate) fn begin(&mut self, token_id: &TokenId, baton: &mut Baton, op: Op) -> U64 {
        let id = U64(self.next_lock);
        self.next_lock += 1;
        baton.lock = Some(Lock { id, op, since_block: U64(env::block_height()) });
        baton.version = U64(baton.version.0 + 1);
        self.void_listing(token_id);
        id
    }

    pub(crate) fn void_listing(&mut self, token_id: &TokenId) {
        if let Some(listing) = self.listings.remove(token_id) {
            emit_baton("delisted", &serde_json::json!({ "token_id": token_id, "listing_id": listing.id }));
        }
    }

    pub(crate) fn credit_refund(&mut self, account: &AccountId, amount: u128) {
        let held = self.refunds.get(account).copied().unwrap_or(0);
        self.refunds.insert(account.clone(), held + amount);
        emit_baton("refund_credited", &serde_json::json!({ "account_id": account, "amount": U128(amount) }));
    }

    /// True while `owner` can take another token. Checked where a panic is safe, at the start of
    /// a user's own call. Callbacks must never panic on this, or a lock or vault could be stranded.
    pub(crate) fn has_capacity(&self, owner: &AccountId) -> bool {
        self.owners.get(owner).map_or(0, Vec::len) < MAX_TOKENS_PER_OWNER
    }

    pub(crate) fn own(&mut self, owner: &AccountId, token_id: &TokenId) {
        self.owners.entry(owner.clone()).or_default().push(token_id.clone());
    }

    pub(crate) fn disown(&mut self, owner: &AccountId, token_id: &TokenId) {
        let empty = {
            let ids = self.owners.get_mut(owner).unwrap_or_else(|| env::panic_str("Owner not indexed"));
            ids.retain(|id| id != token_id);
            ids.is_empty()
        };
        if empty {
            self.owners.remove(owner);
        }
    }

    /// Moves title. Callers have already checked who may do this and that nothing is in flight.
    pub(crate) fn hand_over(&mut self, token_id: &TokenId, baton: &mut Baton, to: &AccountId, price: u128, kind: EntryKind, memo: Option<String>) {
        let from = baton.owner.clone();
        self.disown(&from, token_id);
        self.own(to, token_id);
        self.void_listing(token_id);

        baton.owner = to.clone();
        baton.rotation_seq = U64(baton.rotation_seq.0 + 1);
        baton.version = U64(baton.version.0 + 1);
        push_leg(baton, to.clone(), price);
        push_entry(baton, kind, price, to.clone());

        emit_nep171(
            "nft_transfer",
            &serde_json::json!({
                "old_owner_id": from,
                "new_owner_id": to,
                "token_ids": [token_id],
                "memo": memo,
            }),
        );
        emit_metadata_update(token_id);

        ext_vault::ext(token_id.clone()).with_static_gas(GAS_ROTATE).rotate(to.clone(), baton.rotation_seq.0).detach();
    }

    pub(crate) fn snapshot_of(&self, token_id: &TokenId, pool: &AccountId) -> Promise {
        ext_pool::ext(pool.clone())
            .with_static_gas(GAS_POOL_VIEW)
            .get_account(token_id.clone())
            .and(ext_vault::ext(token_id.clone()).with_static_gas(GAS_VAULT_VIEW).liquid())
    }

    /// Accepts only sub-accounts of the official pool factory, which no one else can create.
    pub(crate) fn assert_official_pool(&self, pool: &AccountId) {
        let label = pool.as_str().strip_suffix(self.pool_suffix.as_str());
        require!(matches!(label, Some(l) if !l.is_empty() && !l.contains('.')), "Not a pool from the official factory");
    }
}

pub(crate) fn push_leg(baton: &mut Baton, holder: AccountId, price: u128) {
    if baton.legs.len() == MAX_LEGS {
        // The first holder is kept, so the origin of a Baton is never lost.
        baton.legs.remove(1);
    }
    baton.legs.push(Leg {
        holder,
        since_ns: U64(env::block_timestamp()),
        price: U128(price),
        earned_at_start: baton.earned,
        paid_out_at_start: baton.paid_out,
    });
    baton.legs_total += 1;
}

pub(crate) fn push_entry(baton: &mut Baton, kind: EntryKind, amount: u128, who: AccountId) {
    if baton.log.len() == MAX_LOG {
        baton.log.remove(0);
    }
    baton.log.push(Entry {
        kind,
        amount: U128(amount),
        who,
        at_ns: U64(env::block_timestamp()),
        epoch: U64(env::epoch_height()),
    });
    baton.log_total += 1;
}

fn emit(standard: &str, version: &str, event: &str, data: &serde_json::Value) {
    let event = serde_json::json!({ "standard": standard, "version": version, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{event}"));
}

pub(crate) fn emit_nep171(event: &str, data: &serde_json::Value) {
    emit("nep171", "1.2.0", event, data);
}

pub(crate) fn emit_baton(event: &str, data: &serde_json::Value) {
    emit("baton", "1.0.0", event, data);
}

pub(crate) fn emit_metadata_update(token_id: &TokenId) {
    emit_nep171("nft_metadata_update", &serde_json::json!({ "token_ids": [token_id] }));
}
