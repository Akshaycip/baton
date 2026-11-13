//! One Baton's account.
//!
//! A vault is a real NEAR account and an ordinary delegator at one staking pool. It has no access
//! keys and takes orders only from its parent, the collection, which only accepts orders from the
//! current NFT holder.
//!
//! The contract uses the low-level host calls on purpose. A compiled wasm lists every host function
//! it can reach, so by not linking `Promise` this binary imports no way to add a key, delete a key,
//! deploy code, create an account or delete itself. `tests/vault-proofs.test.mjs` reads the import
//! table and fails if any of those appear.

use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault};

/// NEAR held back from `liquid` to keep the account alive. It matches what the collection funds.
pub const RESERVE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

/// Margin above the account's storage cost, used only if storage ever exceeds `RESERVE`.
const STORAGE_MARGIN: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR

const GAS_POOL_OP: Gas = Gas::from_tgas(75);
const GAS_ON_POOL: Gas = Gas::from_tgas(5);
const GAS_ON_PAID: Gas = Gas::from_tgas(3);
const NONE: NearToken = NearToken::from_yoctonear(0);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    /// The one staking pool this vault can ever use. Set at creation, never changed.
    pool: AccountId,
    /// Mirror of the holder, for `nft_item_info` only. Authorization never reads it.
    owner: AccountId,
    /// Counts ownership changes. Only moves forward.
    rotation_seq: u64,
}

fn parent() -> AccountId {
    let me = env::current_account_id();
    let (_, parent) = me.as_str().split_once('.').unwrap_or_else(|| env::panic_str("Vault must be a sub-account"));
    parent.parse().unwrap_or_else(|_| env::panic_str("Bad parent account"))
}

fn only_collection() {
    require!(env::predecessor_account_id() == parent(), "Only the collection can instruct this vault");
}

/// What the vault can pay out: its balance minus what keeps the account alive.
fn liquid_yocto() -> u128 {
    let storage = env::storage_byte_cost().as_yoctonear() * u128::from(env::storage_usage()) + STORAGE_MARGIN;
    env::account_balance().as_yoctonear().saturating_sub(RESERVE.max(storage))
}

/// Result of the last promise, without linking the high-level promise machinery.
fn last_promise_succeeded() -> bool {
    require!(env::promise_results_count() == 1, "Expected one promise result");
    env::promise_result_checked(0, 1024).is_ok()
}

fn return_json(json: &str) {
    env::value_return(json.as_bytes());
}

impl Vault {
    /// Calls the pinned pool and reports back whether the pool accepted it.
    fn call_pool(&self, method: &str, args: &[u8], deposit: NearToken) {
        let call = env::promise_batch_create(&self.pool);
        env::promise_batch_action_function_call(call, method, args, deposit, GAS_POOL_OP);
        let done = env::promise_batch_then(call, &env::current_account_id());
        env::promise_batch_action_function_call(done, "on_pool", b"", NONE, GAS_ON_POOL);
        env::promise_return(done);
    }
}

// Orders from the collection are borsh, and answers are written by hand. Leaving JSON parsing
// out keeps this binary small, which is what its one-time publishing fee is charged on.
#[near]
impl Vault {
    /// Runs once, inside the batch that creates this account.
    #[init]
    pub fn init(#[serializer(borsh)] pool: AccountId, #[serializer(borsh)] owner: AccountId) -> Self {
        only_collection();
        Self { pool, owner, rotation_seq: 1 }
    }

    /// Stakes `amount` from this account's balance, including any deposit attached to this call.
    #[payable]
    pub fn stake(&mut self, #[serializer(borsh)] amount: u128) {
        only_collection();
        require!(amount > 0 && amount <= liquid_yocto(), "Not enough liquid NEAR to stake");
        self.call_pool("deposit_and_stake", b"", NearToken::from_yoctonear(amount));
    }

    /// Starts unbonding `amount`, or everything when `amount` is empty.
    pub fn unstake(&self, #[serializer(borsh)] amount: Option<u128>) {
        only_collection();
        match amount {
            Some(value) => self.call_pool("unstake", format!("{{\"amount\":\"{value}\"}}").as_bytes(), NONE),
            None => self.call_pool("unstake_all", b"", NONE),
        }
    }

    /// Brings finished unbonding NEAR from the pool back to this account.
    pub fn withdraw(&self) {
        only_collection();
        self.call_pool("withdraw_all", b"", NONE);
    }

    /// Pays liquid NEAR to `to`. The collection names the holder and holds its lock until this ends.
    pub fn pay(&self, #[serializer(borsh)] to: AccountId, #[serializer(borsh)] amount: Option<u128>) {
        only_collection();
        let liquid = liquid_yocto();
        let amount = amount.unwrap_or(liquid);
        require!(amount > 0 && amount <= liquid, "Not enough liquid NEAR to pay");

        let payment = env::promise_batch_create(&to);
        env::promise_batch_action_transfer(payment, NearToken::from_yoctonear(amount));
        let done = env::promise_batch_then(payment, &env::current_account_id());
        env::promise_batch_action_function_call(done, "on_paid", &amount.to_le_bytes(), NONE, GAS_ON_PAID);
        env::promise_return(done);
    }

    /// Records a new holder. Older rotations are ignored, whatever order they arrive in.
    pub fn rotate(&mut self, #[serializer(borsh)] owner: AccountId, #[serializer(borsh)] seq: u64) {
        only_collection();
        if seq > self.rotation_seq {
            self.owner = owner;
            self.rotation_seq = seq;
        }
    }

    /// Answers `true` if the pool accepted the call.
    #[private]
    pub fn on_pool(&self) {
        return_json(if last_promise_succeeded() { "true" } else { "false" });
    }

    /// Answers what was really paid, zero if the transfer bounced and the NEAR came back.
    #[private]
    pub fn on_paid(&self, #[serializer(borsh)] amount: u128) {
        let paid = if last_promise_succeeded() { amount } else { 0 };
        return_json(&format!("\"{paid}\""));
    }

    /// NEAR ready to claim, as a JSON string of yoctoNEAR.
    pub fn liquid(&self) {
        return_json(&format!("\"{}\"", liquid_yocto()));
    }

    pub fn vault_info(&self) {
        return_json(&format!(
            "{{\"collection_id\":\"{}\",\"pool_id\":\"{}\",\"liquid\":\"{}\",\"reserve\":\"{}\"}}",
            parent(),
            self.pool,
            liquid_yocto(),
            RESERVE,
        ));
    }

    /// Sharded NFT Items draft: this account is the item, and its name is the token id.
    pub fn nft_item_info(&self) {
        return_json(&format!(
            "{{\"spec\":\"sharded-item-1.0.0\",\"init\":true,\"status\":\"Active\",\"collection_id\":\"{}\",\"token_id\":\"{}\",\"owner_id\":\"{}\",\"rotation_seq\":\"{}\",\"rotation_epoch\":1}}",
            parent(),
            env::current_account_id(),
            self.owner,
            self.rotation_seq,
        ));
    }
}
