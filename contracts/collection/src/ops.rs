//! What a holder can do with a Baton. Each operation has the same shape:
//! check the holder, take the lock, call the vault, and release the lock in a callback that the
//! runtime runs even if the call before it failed.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise, PromiseError, PromiseOrValue};

use crate::*;

fn no_lock_match() -> PromiseOrValue<bool> {
    env::log_str("Callback ignored: this lock has already been released");
    PromiseOrValue::Value(false)
}

fn holds(baton: &Baton, lock: U64) -> bool {
    matches!(&baton.lock, Some(held) if held.id == lock)
}

#[near]
impl Collection {
    /// Creates a vault, stakes the deposit at `pool` and issues the NFT to `receiver_id`,
    /// or to the caller when no receiver is given.
    #[payable]
    pub fn baton_mint(&mut self, pool: AccountId, receiver_id: Option<AccountId>) -> Promise {
        self.assert_official_pool(&pool);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= MIN_STAKE + VAULT_RESERVE + TOKEN_STORAGE, "Attach at least 1.06 NEAR");

        let payer = env::predecessor_account_id();
        let owner = receiver_id.unwrap_or_else(|| payer.clone());
        require!(self.has_capacity(&owner), "This account holds too many Batons");
        let token_id: TokenId = format!("b{}.{}", self.next_id, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("Collection name is too long for sub-accounts"));
        self.next_id += 1;

        let stake = deposit - VAULT_RESERVE - TOKEN_STORAGE;
        let init_args = near_sdk::borsh::to_vec(&(&pool, &owner)).unwrap_or_else(|_| env::panic_str("Cannot encode arguments"));

        // No AddKey in this batch, so the vault has no access keys from its first block.
        // If any step fails, all of it rolls back and the NEAR returns to this contract.
        Promise::new(token_id.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(stake + VAULT_RESERVE))
            .use_global_contract(self.vault_code)
            .function_call("init".to_string(), init_args, NearToken::from_yoctonear(0), GAS_VAULT_INIT)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_MINTED).on_vault_created(
                token_id,
                owner,
                payer,
                pool,
                U128(stake),
                U128(deposit),
            ))
    }

    #[private]
    pub fn on_vault_created(
        &mut self,
        token_id: TokenId,
        owner: AccountId,
        payer: AccountId,
        pool: AccountId,
        stake: U128,
        deposit: U128,
    ) -> PromiseOrValue<bool> {
        if !near_sdk::is_promise_success() {
            self.credit_refund(&payer, deposit.0);
            return PromiseOrValue::Value(false);
        }

        let now = U64(env::block_timestamp());
        let mut baton = Baton {
            owner: owner.clone(),
            pool,
            minted_at_ns: now,
            rotation_seq: U64(1),
            version: U64(1),
            lock: None,
            deposited: U128(0),
            paid_out: U128(0),
            earned: U128(0),
            staked: U128(0),
            unstaked: U128(0),
            liquid: U128(stake.0),
            can_withdraw: false,
            unlock_epoch: U64(0),
            synced_at_ns: now,
            legs: Vec::new(),
            legs_total: 0,
            log: Vec::new(),
            log_total: 0,
        };
        let lock = self.begin(&token_id, &mut baton, Op::Mint);
        push_leg(&mut baton, owner.clone(), 0);
        push_entry(&mut baton, EntryKind::Minted, stake.0, owner.clone());
        self.own(&owner, &token_id);
        self.save(&token_id, baton);

        emit_nep171("nft_mint", &serde_json::json!({ "owner_id": owner, "token_ids": [token_id] }));

        ext_vault::ext(token_id.clone())
            .with_static_gas(GAS_VAULT_POOL_OP)
            .stake(stake.0)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_OP).on_staked(
                token_id, lock, stake, None,
            ))
            .into()
    }

    /// Adds the attached NEAR to this Baton's stake.
    #[payable]
    pub fn baton_stake(&mut self, token_id: TokenId) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit.as_yoctonear() >= MIN_TOP_UP, "Attach at least 0.1 NEAR");
        let mut baton = self.holder_baton(&token_id);
        let lock = self.begin(&token_id, &mut baton, Op::Stake);
        self.save(&token_id, baton);

        let amount = U128(deposit.as_yoctonear());
        ext_vault::ext(token_id.clone())
            .with_attached_deposit(deposit)
            .with_static_gas(GAS_VAULT_POOL_OP)
            .stake(amount.0)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_OP).on_staked(
                token_id,
                lock,
                amount,
                Some(env::predecessor_account_id()),
            ))
    }

    /// `payer` is set when the NEAR was attached to this call. If the vault itself refused it,
    /// that NEAR has come back here and is credited to the payer.
    #[private]
    pub fn on_staked(
        &mut self,
        token_id: TokenId,
        lock: U64,
        amount: U128,
        payer: Option<AccountId>,
        #[callback_result] result: Result<bool, PromiseError>,
    ) -> PromiseOrValue<bool> {
        let mut baton = self.baton(&token_id);
        if !holds(&baton, lock) {
            return no_lock_match();
        }
        let who = baton.owner.clone();
        match (result, payer) {
            (Ok(true), _) => {
                baton.deposited = U128(baton.deposited.0 + amount.0);
                push_entry(&mut baton, EntryKind::Staked, amount.0, who);
            }
            (Ok(false), _) | (Err(_), None) => {
                // The pool refused it, so the NEAR is liquid in the vault and still the holder's.
                baton.deposited = U128(baton.deposited.0 + amount.0);
                push_entry(&mut baton, EntryKind::StakeReturned, amount.0, who);
            }
            (Err(_), Some(payer)) => self.credit_refund(&payer, amount.0),
        }
        let pool = baton.pool.clone();
        self.save(&token_id, baton);
        self.snapshot_then(token_id, &pool, lock, After::Release).into()
    }

    /// Starts unbonding `amount`, or everything when `amount` is empty.
    ///
    /// The pool restarts the wait for the whole unbonding balance on every unstake. The listing is
    /// voided here, so that cannot be used to change the wait after a buyer has seen it.
    #[payable]
    pub fn baton_unstake(&mut self, token_id: TokenId, amount: Option<U128>) -> Promise {
        assert_one_yocto();
        let mut baton = self.holder_baton(&token_id);
        let lock = self.begin(&token_id, &mut baton, Op::Unstake);
        let requested = amount.unwrap_or(baton.staked);
        self.save(&token_id, baton);

        ext_vault::ext(token_id.clone())
            .with_static_gas(GAS_VAULT_POOL_OP)
            .unstake(amount.map(|value| value.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_AFTER_OP).on_unstaked(token_id, lock, requested))
    }

    #[private]
    pub fn on_unstaked(&mut self, token_id: TokenId, lock: U64, amount: U128, #[callback_result] result: Result<bool, PromiseError>) -> PromiseOrValue<bool> {
        let mut baton = self.baton(&token_id);
        if !holds(&baton, lock) {
            return no_lock_match();
        }
        if matches!(result, Ok(true)) {
            baton.unlock_epoch = U64(env::epoch_height() + UNBONDING_EPOCHS);
            let who = baton.owner.clone();
            push_entry(&mut baton, EntryKind::UnbondingStarted, amount.0, who);
        }
        let pool = baton.pool.clone();
        self.save(&token_id, baton);
        self.snapshot_then(token_id, &pool, lock, After::Release).into()
    }

    /// Brings finished unbonding NEAR from the pool into the vault.
    #[payable]
    pub fn baton_withdraw(&mut self, token_id: TokenId) -> Promise {
        assert_one_yocto();
        let mut baton = self.holder_baton(&token_id);
        let lock = self.begin(&token_id, &mut baton, Op::Withdraw);
        self.save(&token_id, baton);

        ext_vault::ext(token_id.clone())
            .with_static_gas(GAS_VAULT_POOL_OP)
            .withdraw()
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CLAIMED).on_withdrawn(token_id, lock))
    }

    /// No snapshot here: the pool's transfer can land after this callback runs, so a snapshot
    /// taken now could miss NEAR that is on its way. The books move by the known amount instead.
    #[private]
    pub fn on_withdrawn(&mut self, token_id: TokenId, lock: U64, #[callback_result] result: Result<bool, PromiseError>) -> bool {
        let mut baton = self.baton(&token_id);
        if !holds(&baton, lock) {
            return false;
        }
        let ok = matches!(result, Ok(true));
        if ok {
            let amount = baton.unstaked;
            baton.liquid = U128(baton.liquid.0 + amount.0);
            baton.unstaked = U128(0);
            baton.can_withdraw = false;
            baton.unlock_epoch = U64(0);
            let who = baton.owner.clone();
            push_entry(&mut baton, EntryKind::Withdrawn, amount.0, who);
            emit_metadata_update(&token_id);
        }
        baton.lock = None;
        self.save(&token_id, baton);
        ok
    }

    /// Pays liquid NEAR to the caller, who is the holder when this starts and, because the lock
    /// is held throughout, is still the holder when it ends.
    #[payable]
    pub fn baton_claim(&mut self, token_id: TokenId, amount: Option<U128>) -> Promise {
        assert_one_yocto();
        let mut baton = self.holder_baton(&token_id);
        let lock = self.begin(&token_id, &mut baton, Op::Claim);
        let holder = baton.owner.clone();
        self.save(&token_id, baton);

        ext_vault::ext(token_id.clone())
            .with_static_gas(GAS_VAULT_PAY)
            .pay(holder.clone(), amount.map(|value| value.0))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_CLAIMED).on_claimed(token_id, lock, holder))
    }

    #[private]
    pub fn on_claimed(&mut self, token_id: TokenId, lock: U64, holder: AccountId, #[callback_result] result: Result<U128, PromiseError>) -> U128 {
        let mut baton = self.baton(&token_id);
        if !holds(&baton, lock) {
            return U128(0);
        }
        let paid = result.map_or(0, |amount| amount.0);
        if paid > 0 {
            baton.paid_out = U128(baton.paid_out.0 + paid);
            baton.liquid = U128(baton.liquid.0.saturating_sub(paid));
            push_entry(&mut baton, EntryKind::Paid, paid, holder);
            emit_metadata_update(&token_id);
        }
        baton.lock = None;
        self.save(&token_id, baton);
        U128(paid)
    }

    /// Refreshes the cached numbers from the pool. Anyone may call this.
    ///
    /// It takes no lock, so calling it repeatedly cannot stop a Baton from being sold. Its result
    /// is dropped if the Baton changed in the meantime.
    pub fn baton_sync(&mut self, token_id: TokenId) -> Promise {
        let baton = self.baton(&token_id);
        self.snapshot_then(token_id, &baton.pool, U64(0), After::Sync { version: baton.version })
    }

    /// Releases a lock that has been stuck for `UNSTICK_AFTER_BLOCKS`. Anyone may call this.
    pub fn baton_unstick(&mut self, token_id: TokenId) {
        let mut baton = self.baton(&token_id);
        let lock = baton.lock.clone().unwrap_or_else(|| env::panic_str("This Baton is not locked"));
        require!(env::block_height() >= lock.since_block.0 + UNSTICK_AFTER_BLOCKS, "This lock has not timed out yet");
        baton.lock = None;
        baton.version = U64(baton.version.0 + 1);
        self.save(&token_id, baton);
        emit_baton("unstuck", &serde_json::json!({ "token_id": token_id, "lock": lock.id }));
    }

    /// Applies a snapshot, then does whatever was waiting for it. Runs even when the views failed.
    #[private]
    pub fn on_snapshot(
        &mut self,
        token_id: TokenId,
        lock: U64,
        after: After,
        #[callback_result] pool: Result<PoolAccount, PromiseError>,
        #[callback_result] liquid: Result<U128, PromiseError>,
    ) -> bool {
        let mut baton = match self.batons.get(&token_id) {
            Some(baton) => baton.clone(),
            None => return false,
        };

        if let After::Sync { version } = after {
            let fresh = baton.lock.is_none() && baton.version == version;
            let (Ok(pool), Ok(liquid), true) = (pool, liquid, fresh) else {
                return false;
            };
            apply_snapshot(&mut baton, pool, liquid);
            self.save(&token_id, baton);
            emit_metadata_update(&token_id);
            return true;
        }

        if !holds(&baton, lock) {
            return false;
        }

        let snapshot = match (pool, liquid) {
            (Ok(pool), Ok(liquid)) => Some((pool, liquid)),
            _ => None,
        };
        let Some((pool, liquid)) = snapshot else {
            // Without fresh numbers nothing can be priced. Release and let the holder retry.
            baton.lock = None;
            self.save(&token_id, baton);
            return false;
        };
        apply_snapshot(&mut baton, pool, liquid);
        emit_metadata_update(&token_id);

        match after {
            After::Release | After::Sync { .. } => {
                baton.lock = None;
                self.save(&token_id, baton);
                true
            }
            After::List { price } => {
                self.open_listing(&token_id, &mut baton, price);
                baton.lock = None;
                self.save(&token_id, baton);
                true
            }
            After::Fill { bid_id, min_price } => {
                let filled = self.settle_fill(&token_id, &mut baton, bid_id, min_price);
                baton.lock = None;
                self.save(&token_id, baton);
                filled
            }
        }
    }
}

fn apply_snapshot(baton: &mut Baton, pool: PoolAccount, liquid: U128) {
    baton.staked = pool.staked_balance;
    baton.unstaked = pool.unstaked_balance;
    baton.can_withdraw = pool.can_withdraw;
    baton.liquid = liquid;
    if !render::holds(baton.unstaked) {
        baton.unlock_epoch = U64(0);
    }
    baton.synced_at_ns = U64(env::block_timestamp());

    // Everything the position has ever been worth, minus everything put in. Rewards only go up,
    // so a momentary dip (NEAR in transit between pool and vault) never lowers the record.
    let worth = baton.staked.0 + baton.unstaked.0 + baton.liquid.0 + baton.paid_out.0;
    baton.earned = U128(baton.earned.0.max(worth.saturating_sub(baton.deposited.0)));
}

impl Collection {
    pub(crate) fn snapshot_then(&self, token_id: TokenId, pool: &AccountId, lock: U64, after: After) -> Promise {
        self.snapshot_of(&token_id, pool)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_SNAPSHOT).on_snapshot(token_id, lock, after))
    }
}
