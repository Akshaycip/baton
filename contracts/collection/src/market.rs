//! Selling a Baton: fixed-price listings, and standing bids a holder can sell into instantly.
//!
//! A listing records what the position held when it was offered. Any later operation deletes the
//! listing, and the buyer's transaction names the listing id, so a buyer gets what they saw.

use near_sdk::json_types::{U128, U64};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise};

use crate::*;

#[near]
impl Collection {
    /// Offers this Baton for `price`. The listing opens once a fresh snapshot has come back.
    #[payable]
    pub fn baton_list(&mut self, token_id: TokenId, price: U128) -> Promise {
        assert_one_yocto();
        require!(price.0 > 0, "Price must be above zero");
        let mut baton = self.holder_baton(&token_id);
        let lock = self.begin(&token_id, &mut baton, Op::List);
        let pool = baton.pool.clone();
        self.save(&token_id, baton);
        self.snapshot_then(token_id, &pool, lock, After::List { price })
    }

    #[payable]
    pub fn baton_delist(&mut self, token_id: TokenId) {
        assert_one_yocto();
        let mut baton = self.holder_baton(&token_id);
        require!(self.listings.contains_key(&token_id), "Not listed");
        self.void_listing(&token_id);
        let who = baton.owner.clone();
        push_entry(&mut baton, EntryKind::Delisted, 0, who);
        self.save(&token_id, baton);
    }

    /// Buys a listed Baton in one step. `listing_id` is the listing the buyer actually saw.
    #[payable]
    pub fn baton_buy(&mut self, token_id: TokenId, listing_id: U64) {
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        let listing = self.listings.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("This Baton is not for sale"));
        require!(listing.id == listing_id, "This listing has changed. Check it again");
        require!(deposit >= listing.price.0, "Attached NEAR is below the price");

        let mut baton = self.baton(&token_id);
        require!(baton.lock.is_none(), "This Baton is mid-operation");
        require!(baton.owner == listing.seller, "The seller no longer holds this Baton");
        require!(buyer != baton.owner, "You already hold this Baton");
        require!(self.has_capacity(&buyer), "This account holds too many Batons");

        let seller = baton.owner.clone();
        self.hand_over(&token_id, &mut baton, &buyer, listing.price.0, EntryKind::Sold, Some("sale".to_string()));
        self.save(&token_id, baton);

        emit_baton(
            "sold",
            &serde_json::json!({ "token_id": token_id, "seller": seller, "buyer": buyer, "price": listing.price, "listing_id": listing_id }),
        );
        self.pay_seller(&seller, listing.price.0);
        if deposit > listing.price.0 {
            Promise::new(buyer).transfer(NearToken::from_yoctonear(deposit - listing.price.0)).detach();
        }
    }

    /// Places NEAR ready to buy any position worth at most what it holds, at a `discount_bps`
    /// discount to value, as long as the NEAR is available within `max_epochs`.
    #[payable]
    pub fn baton_bid(&mut self, discount_bps: u16, max_epochs: u8) -> U64 {
        require!(discount_bps < 5_000, "Discount must be below 50%");
        require!(u64::from(max_epochs) <= UNBONDING_EPOCHS, "max_epochs is at most 4");
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= MIN_BID_REMAINING + BID_STORAGE, "Attach at least 0.105 NEAR");

        let id = self.next_bid;
        self.next_bid += 1;
        let bid = Bid {
            id: U64(id),
            bidder: env::predecessor_account_id(),
            remaining: U128(deposit - BID_STORAGE),
            discount_bps,
            max_epochs,
            placed_at_ns: U64(env::block_timestamp()),
        };
        emit_baton("bid_placed", &serde_json::json!(bid));
        self.bids.insert(id, bid);
        U64(id)
    }

    pub fn baton_bid_cancel(&mut self, bid_id: U64) -> Promise {
        let bid = self.bids.get(&bid_id.0).cloned().unwrap_or_else(|| env::panic_str("No such bid"));
        require!(bid.bidder == env::predecessor_account_id(), "Only the bidder can cancel");
        self.bids.remove(&bid_id.0);
        emit_baton("bid_closed", &serde_json::json!({ "bid_id": bid_id }));
        Promise::new(bid.bidder).transfer(NearToken::from_yoctonear(bid.remaining.0 + BID_STORAGE))
    }

    /// Sells this Baton into a standing bid. `min_price` protects the seller if the value moved.
    #[payable]
    pub fn baton_fill(&mut self, token_id: TokenId, bid_id: U64, min_price: U128) -> Promise {
        assert_one_yocto();
        let mut baton = self.holder_baton(&token_id);
        require!(self.bids.contains_key(&bid_id.0), "No such bid");
        let lock = self.begin(&token_id, &mut baton, Op::Fill);
        let pool = baton.pool.clone();
        self.save(&token_id, baton);
        self.snapshot_then(token_id, &pool, lock, After::Fill { bid_id, min_price })
    }

    /// Collects NEAR that could not be delivered earlier.
    pub fn baton_claim_refund(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.refunds.remove(&account).unwrap_or_else(|| env::panic_str("Nothing to collect"));
        Promise::new(account).transfer(NearToken::from_yoctonear(amount))
    }

    /// A transfer to a deleted account returns the NEAR here. It waits as a claimable balance.
    #[private]
    pub fn on_proceeds(&mut self, seller: AccountId, amount: U128) {
        if !near_sdk::is_promise_success() {
            self.credit_refund(&seller, amount.0);
        }
    }
}

impl Collection {
    pub(crate) fn open_listing(&mut self, token_id: &TokenId, baton: &mut Baton, price: U128) {
        let id = U64(self.next_listing);
        self.next_listing += 1;
        let listing = Listing {
            id,
            token_id: token_id.clone(),
            seller: baton.owner.clone(),
            price,
            listed_at_ns: U64(env::block_timestamp()),
            staked: baton.staked,
            unstaked: baton.unstaked,
            liquid: baton.liquid,
            unlock_epoch: baton.unlock_epoch,
        };
        let who = baton.owner.clone();
        push_entry(baton, EntryKind::Listed, price.0, who);
        emit_baton("listed", &serde_json::json!(listing));
        self.listings.insert(token_id.clone(), listing);
    }

    /// Runs after the snapshot, under the lock. Returns false and moves nothing if any term fails.
    pub(crate) fn settle_fill(&mut self, token_id: &TokenId, baton: &mut Baton, bid_id: U64, min_price: U128) -> bool {
        let Some(mut bid) = self.bids.get(&bid_id.0).cloned() else {
            env::log_str("Fill failed: the bid is gone");
            return false;
        };
        let seller = baton.owner.clone();
        let value = baton.staked.0 + baton.unstaked.0 + baton.liquid.0;
        let price = value * u128::from(10_000 - bid.discount_bps) / 10_000;
        let wait = render::epochs_left(baton, env::epoch_height());

        let terms_met = bid.bidder != seller
            && self.has_capacity(&bid.bidder)
            && wait <= u64::from(bid.max_epochs)
            && price > 0
            && price >= min_price.0
            && price <= bid.remaining.0;
        if !terms_met {
            env::log_str("Fill failed: this position does not meet the bid's terms");
            return false;
        }

        bid.remaining = U128(bid.remaining.0 - price);
        let bidder = bid.bidder.clone();
        if bid.remaining.0 < MIN_BID_REMAINING {
            self.bids.remove(&bid_id.0);
            emit_baton("bid_closed", &serde_json::json!({ "bid_id": bid_id }));
            Promise::new(bidder.clone()).transfer(NearToken::from_yoctonear(bid.remaining.0 + BID_STORAGE)).detach();
        } else {
            self.bids.insert(bid_id.0, bid);
        }

        self.hand_over(token_id, baton, &bidder, price, EntryKind::Sold, Some("bid".to_string()));
        emit_baton(
            "sold",
            &serde_json::json!({ "token_id": token_id, "seller": seller, "buyer": bidder, "price": U128(price), "bid_id": bid_id }),
        );
        self.pay_seller(&seller, price);
        true
    }

    pub(crate) fn pay_seller(&mut self, seller: &AccountId, price: u128) {
        let fee = price * u128::from(self.fee_bps) / 10_000;
        let proceeds = price - fee;
        Promise::new(seller.clone())
            .transfer(NearToken::from_yoctonear(proceeds))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_PROCEEDS).on_proceeds(seller.clone(), U128(proceeds)))
            .detach();
        if fee > 0 {
            Promise::new(self.treasury.clone()).transfer(NearToken::from_yoctonear(fee)).detach();
        }
    }
}
