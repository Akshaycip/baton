//! Data the collection stores and returns.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// A token id is the vault's account name. Only this contract can create such a name.
pub type TokenId = AccountId;

/// What is in flight on a Baton. While any of these is set, the Baton cannot change hands.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Op {
    Mint,
    Stake,
    Unstake,
    Withdraw,
    Claim,
    List,
    Fill,
    TransferCall,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Lock {
    pub id: U64,
    pub op: Op,
    pub since_block: U64,
}

/// One holder's stretch of the chain of title.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Leg {
    pub holder: AccountId,
    pub since_ns: U64,
    /// What this holder paid for it. Zero for a mint or a gift.
    pub price: U128,
    pub earned_at_start: U128,
    pub paid_out_at_start: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum EntryKind {
    Minted,
    Staked,
    StakeReturned,
    UnbondingStarted,
    Withdrawn,
    Paid,
    Listed,
    Delisted,
    Sold,
    Transferred,
}

/// One line of a Baton's history.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub kind: EntryKind,
    pub amount: U128,
    pub who: AccountId,
    pub at_ns: U64,
    pub epoch: U64,
}

/// Everything the registry knows about one Baton.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Baton {
    pub owner: AccountId,
    pub pool: AccountId,
    pub minted_at_ns: U64,
    /// Counts ownership changes. Matches the vault's mirror once both have settled.
    pub rotation_seq: U64,
    /// Bumps whenever the position or its owner changes. A stale snapshot is dropped by this.
    pub version: U64,
    pub lock: Option<Lock>,

    pub deposited: U128,
    pub paid_out: U128,
    pub earned: U128,
    pub staked: U128,
    pub unstaked: U128,
    pub liquid: U128,
    pub can_withdraw: bool,
    /// Epoch at which unbonding NEAR can be withdrawn. Zero when nothing is unbonding.
    pub unlock_epoch: U64,
    pub synced_at_ns: U64,

    pub legs: Vec<Leg>,
    pub legs_total: u32,
    pub log: Vec<Entry>,
    pub log_total: u32,
}

/// An offer to sell. The buyer's transaction names `id`, so it cannot buy anything else.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub id: U64,
    pub token_id: TokenId,
    pub seller: AccountId,
    pub price: U128,
    pub listed_at_ns: U64,
    pub staked: U128,
    pub unstaked: U128,
    pub liquid: U128,
    pub unlock_epoch: U64,
}

/// NEAR waiting to buy any position that fits, so a holder can exit in one click.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Bid {
    pub id: U64,
    pub bidder: AccountId,
    pub remaining: U128,
    /// Discount to position value, in hundredths of a percent.
    pub discount_bps: u16,
    /// The longest the bidder will wait for NEAR, in epochs. Staked positions count as 4.
    pub max_epochs: u8,
    pub placed_at_ns: U64,
}

/// What `get_account` returns on a staking pool.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct PoolAccount {
    pub account_id: AccountId,
    pub unstaked_balance: U128,
    pub staked_balance: U128,
    pub can_withdraw: bool,
}

/// What to do once a snapshot of the position has come back.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum After {
    Release,
    List { price: U128 },
    Fill { bid_id: U64, min_price: U128 },
    Sync { version: U64 },
}

#[near(serializers = [json])]
pub struct BatonView {
    pub token_id: TokenId,
    pub status: String,
    pub epoch: U64,
    pub epochs_left: U64,
    pub listing: Option<Listing>,
    pub baton: Baton,
}

#[near(serializers = [json])]
pub struct Config {
    pub vault_code_hash: near_sdk::json_types::Base58CryptoHash,
    pub pool_suffix: String,
    pub fee_bps: u16,
    pub treasury: AccountId,
    pub min_stake: U128,
    pub mint_overhead: U128,
    pub bid_overhead: U128,
    pub unbonding_epochs: U64,
    pub unstick_after_blocks: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub media: Option<String>,
    pub media_hash: Option<String>,
    pub copies: Option<u64>,
    pub issued_at: Option<String>,
    pub expires_at: Option<String>,
    pub starts_at: Option<String>,
    pub updated_at: Option<String>,
    pub extra: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Token {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub metadata: TokenMetadata,
}

#[near(serializers = [json])]
pub struct ContractMetadata {
    pub spec: String,
    pub name: String,
    pub symbol: String,
    pub icon: Option<String>,
    pub base_uri: Option<String>,
    pub reference: Option<String>,
    pub reference_hash: Option<String>,
}
