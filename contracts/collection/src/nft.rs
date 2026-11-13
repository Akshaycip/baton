//! NEP-171 core, NEP-177 metadata and NEP-181 enumeration.
//!
//! NEP-178 approvals are deliberately not offered. An approval left behind is a way back into a
//! token after it has been sold, and a third-party market cannot honour the listing rules here.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, PromiseOrValue};

use crate::*;

fn refuse_approval(approval_id: Option<u64>) {
    require!(approval_id.is_none(), "Approvals are not offered on Batons");
}

#[near]
impl Collection {
    #[payable]
    pub fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        assert_one_yocto();
        refuse_approval(approval_id);
        let mut baton = self.holder_baton(&token_id);
        require!(receiver_id != baton.owner, "Already the holder");
        require!(self.has_capacity(&receiver_id), "This account holds too many Batons");
        self.hand_over(&token_id, &mut baton, &receiver_id, 0, EntryKind::Transferred, memo);
        self.save(&token_id, baton);
    }

    /// The token stays locked until `nft_resolve_transfer`. Without that, a receiver could empty
    /// the vault during `nft_on_transfer` and then hand back an empty token by returning `true`.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        refuse_approval(approval_id);
        let mut baton = self.holder_baton(&token_id);
        let sender = baton.owner.clone();
        require!(receiver_id != sender, "Already the holder");
        require!(self.has_capacity(&receiver_id), "This account holds too many Batons");

        self.hand_over(&token_id, &mut baton, &receiver_id, 0, EntryKind::Transferred, memo);
        let lock = self.begin(&token_id, &mut baton, Op::TransferCall);
        self.save(&token_id, baton);

        let forwarded = env::prepaid_gas().saturating_sub(GAS_RESOLVE_TRANSFER).saturating_sub(GAS_ROTATE).saturating_sub(near_sdk::Gas::from_tgas(10));
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(forwarded)
            .nft_on_transfer(sender.clone(), sender.clone(), token_id.clone(), msg)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_RESOLVE_TRANSFER).nft_resolve_transfer(
                sender,
                receiver_id,
                token_id,
                lock,
            ))
            .into()
    }

    /// Returns true if the token stays with the receiver, as NEP-171 requires.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        lock: U64,
        #[callback_result] result: Result<bool, near_sdk::PromiseError>,
    ) -> bool {
        let keep = matches!(result, Ok(false));
        let mut baton = self.baton(&token_id);
        let ours = matches!(&baton.lock, Some(held) if held.id == lock);
        if !ours || baton.owner != receiver_id {
            return true;
        }
        baton.lock = None;
        if !keep {
            self.hand_over(&token_id, &mut baton, &owner_id, 0, EntryKind::Transferred, Some("returned".to_string()));
        }
        self.save(&token_id, baton);
        keep
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.token(&token_id)
    }

    pub fn nft_metadata(&self) -> ContractMetadata {
        ContractMetadata {
            spec: "nft-1.0.0".to_string(),
            name: "Baton".to_string(),
            symbol: "BATON".to_string(),
            icon: Some(render::icon()),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(u128::from(self.batons.len()))
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.batons
            .iter()
            .skip(from_index.map_or(0, |index| index.0 as usize))
            .take(limit.unwrap_or(50).min(100) as usize)
            .filter_map(|(id, _)| self.token(id))
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.owners.get(&account_id).map_or(0, |ids| ids.len() as u128))
    }

    pub fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.owners
            .get(&account_id)
            .map(|ids| {
                ids.iter()
                    .skip(from_index.map_or(0, |index| index.0 as usize))
                    .take(limit.unwrap_or(50).min(100) as usize)
                    .filter_map(|id| self.token(id))
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Collection {
    /// Metadata is computed from live state on every read, so nothing stored can go stale.
    fn token(&self, token_id: &TokenId) -> Option<Token> {
        let baton = self.batons.get(token_id)?;
        Some(Token {
            token_id: token_id.clone(),
            owner_id: baton.owner.clone(),
            metadata: render::metadata(token_id, baton, env::epoch_height()),
        })
    }
}
