//! The NFT's appearance, drawn from live state each time it is read.
//!
//! The picture is a running track. Each lane is one holder, the outermost being the first. The
//! colour shows what the position is doing and the number is what it holds right now.

use near_sdk::json_types::U128;

use crate::*;

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

fn data_uri(svg: &str) -> String {
    format!("data:image/svg+xml;base64,{}", base64(svg.as_bytes()))
}

pub fn near(yocto: u128, decimals: u32) -> String {
    let whole = yocto / ONE_NEAR;
    let fraction = (yocto % ONE_NEAR) / 10u128.pow(24 - decimals);
    format!("{whole}.{fraction:0width$}", width = decimals as usize)
}

/// Staking pools round shares, which can leave a few yoctoNEAR behind in a balance. That rounding
/// is not a position: 4 yoctoNEAR "unstaked" must not make a staked Baton look ready to withdraw.
const DUST: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR

pub fn holds(amount: U128) -> bool {
    amount.0 >= DUST
}

/// How many epochs until this position can be NEAR in hand. Staked NEAR must still unbond.
pub fn epochs_left(baton: &Baton, epoch: u64) -> u64 {
    if holds(baton.staked) {
        UNBONDING_EPOCHS
    } else if holds(baton.unstaked) && !baton.can_withdraw {
        baton.unlock_epoch.0.saturating_sub(epoch).min(UNBONDING_EPOCHS)
    } else {
        0
    }
}

pub fn status(baton: &Baton, epoch: u64) -> (&'static str, &'static str) {
    let unbonding_done = baton.can_withdraw || (baton.unlock_epoch.0 != 0 && epoch >= baton.unlock_epoch.0);
    if baton.lock.is_some() {
        ("Moving", "#a78bfa")
    } else if holds(baton.unstaked) && !unbonding_done {
        ("Unbonding", "#fbbf24")
    } else if holds(baton.unstaked) {
        ("Ready to withdraw", "#38bdf8")
    } else if holds(baton.staked) {
        ("Staked", "#34d399")
    } else if holds(baton.liquid) {
        ("Ready to claim", "#38bdf8")
    } else {
        ("Empty", "#64748b")
    }
}

fn pool_name(pool: &AccountId) -> &str {
    pool.as_str().split('.').next().unwrap_or(pool.as_str())
}

fn value(baton: &Baton) -> u128 {
    baton.staked.0 + baton.unstaked.0 + baton.liquid.0
}

pub fn svg(token_id: &TokenId, baton: &Baton, epoch: u64) -> String {
    let (label, colour) = status(baton, epoch);
    let holders = baton.legs_total.max(1);
    let lanes = holders.min(6);
    let mut art = String::new();
    for lane in 0..lanes {
        let inset = 20 + lane * 15;
        let side = 400 - 2 * inset;
        let radius = 150u32.saturating_sub(lane * 15);
        let (stroke, opacity) = if lane + 1 == lanes { (colour, "1") } else { ("#94a3b8", "0.28") };
        art.push_str(&format!(
            "<rect x='{inset}' y='{inset}' width='{side}' height='{side}' rx='{radius}' fill='none' stroke='{stroke}' stroke-opacity='{opacity}' stroke-width='5'/>"
        ));
    }
    let id = token_id.as_str().split('.').next().unwrap_or("");
    let plural = if holders == 1 { "" } else { "s" };
    format!(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 400' font-family='ui-monospace,Menlo,Consolas,monospace' text-anchor='middle'>\
<rect width='400' height='400' fill='#0b1017'/>{art}\
<text x='200' y='154' fill='{colour}' font-size='17' letter-spacing='2'>{label}</text>\
<text x='200' y='212' fill='#f8fafc' font-size='46' font-weight='700'>{worth}</text>\
<text x='200' y='238' fill='#94a3b8' font-size='14'>NEAR</text>\
<text x='200' y='272' fill='#34d399' font-size='15'>+{earned} earned</text>\
<text x='200' y='302' fill='#94a3b8' font-size='13'>{pool} / {id} / {holders} holder{plural}</text></svg>",
        worth = near(value(baton), 2),
        earned = near(baton.earned.0, 3),
        pool = pool_name(&baton.pool),
    )
}

pub fn icon() -> String {
    data_uri(
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#0b1017'/>\
<rect x='9' y='9' width='46' height='46' rx='23' fill='none' stroke='#34d399' stroke-width='5'/>\
<rect x='27' y='17' width='10' height='30' rx='5' fill='#f8fafc' transform='rotate(35 32 32)'/></svg>",
    )
}

pub fn metadata(token_id: &TokenId, baton: &Baton, epoch: u64) -> TokenMetadata {
    let (label, _) = status(baton, epoch);
    let extra = serde_json::json!({
        "status": label,
        "pool": baton.pool,
        "staked": baton.staked,
        "unstaked": baton.unstaked,
        "liquid": baton.liquid,
        "earned": baton.earned,
        "paid_out": baton.paid_out,
        "unlock_epoch": baton.unlock_epoch,
        "holders": baton.legs_total,
        "rotation_seq": baton.rotation_seq,
        "value": U128(value(baton)),
    });
    TokenMetadata {
        title: Some(format!("Baton {} / {}", token_id.as_str().split('.').next().unwrap_or(""), pool_name(&baton.pool))),
        description: Some(format!(
            "A live NEAR stake. {} NEAR with {}, {} earned, {} holder(s). Selling this NFT sells the position without unstaking.",
            near(value(baton), 2),
            pool_name(&baton.pool),
            near(baton.earned.0, 3),
            baton.legs_total,
        )),
        media: Some(data_uri(&svg(token_id, baton, epoch))),
        media_hash: None,
        copies: Some(1),
        issued_at: Some((baton.minted_at_ns.0 / 1_000_000).to_string()),
        expires_at: None,
        starts_at: None,
        updated_at: Some((baton.synced_at_ns.0 / 1_000_000).to_string()),
        extra: Some(extra.to_string()),
        reference: None,
        reference_hash: None,
    }
}
