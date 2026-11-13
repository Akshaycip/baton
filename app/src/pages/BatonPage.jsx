import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '../App.jsx';
import { GAS, ONE_YOCTO, act, collection, view } from '../api.js';
import { ENTRY_TEXT, dateText, discount, explainError, near, shortAccount, shortName, statusLabel, statusTone, toYocto, waitText, worthOf } from '../format.js';
import { useLive } from '../hooks.js';

/** The best standing offer this position qualifies for, and what it would pay. */
function bestOffer(bids, worth, wait, holder) {
  let best = null;
  for (const bid of bids) {
    if (bid.bidder === holder || Number(wait) > bid.max_epochs) continue;
    const price = (worth * BigInt(10_000 - bid.discount_bps)) / 10_000n;
    if (price > BigInt(bid.remaining) || price === 0n) continue;
    if (!best || price > best.price) best = { bid, price };
  }
  return best;
}

function Figure({ label, value, tone, hint }) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd className={`mono ${tone ?? ''}`}>{value}</dd>
      {hint && <small>{hint}</small>}
    </div>
  );
}

function Result({ notice }) {
  if (!notice) return null;
  return (
    <div className="result">
      <p className={notice.tone === 'good' ? 'ok' : 'error'}>{notice.text}</p>
      {notice.validator && (
        <dl className="validator-proof">
          <div><dt>{notice.validator.name} total stake before</dt><dd className="mono">{near(notice.validator.before, 3)}</dd></div>
          <div><dt>After the sale</dt><dd className="mono">{near(notice.validator.after, 3)}</dd></div>
        </dl>
      )}
      {notice.hash && <a className="tx-link" href={`https://testnet.nearblocks.io/txns/${notice.hash}`} target="_blank" rel="noreferrer">View the transaction</a>}
    </div>
  );
}

function ActionPanel({ item, offer, fee }) {
  const { user, refresh } = useSession();
  const { baton, listing, status, token_id: id, epochs_left: epochsLeft } = item;
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [price, setPrice] = useState('');
  const [topUp, setTopUp] = useState('1');
  const holder = baton.owner === user;
  const worth = worthOf(baton);
  const locked = !!baton.lock;

  const run = async (label, method, args, options, onDone) => {
    setBusy(label);
    setNotice(null);
    try {
      const result = await act(user, method, args, options);
      const good = result.ok && result.value !== false && !(result.failures ?? []).length;
      if (good) setNotice({ tone: 'good', hash: result.hash, ...(onDone ? await onDone(result) : { text: 'Done.' }) });
      else setNotice({ tone: 'bad', text: explainError(result), hash: result.hash });
    } catch (failure) {
      setNotice({ tone: 'bad', text: failure.message });
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const oneYocto = { deposit: ONE_YOCTO, gas: GAS.HIGH };

  if (!holder) {
    return (
      <div className="panel">
        {listing ? (
          <>
            <h3>Buy this Baton</h3>
            <p>
              You pay <b className="mono">{near(listing.price, 2)} NEAR</b> and become the holder of <b className="mono">{near(worth, 2)} NEAR</b>.
              {status === 'Unbonding' && ` It finishes unstaking in ${waitText(epochsLeft)}.`}
            </p>
            <button className="button wide" disabled={!!busy || !user} onClick={() => run('buy', 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: listing.price }, () => ({ text: 'It is yours. The stake never stopped.' }))}>
              {busy ? 'Buying…' : `Buy for ${near(listing.price, 2)} NEAR`}
            </button>
          </>
        ) : (
          <p className="muted">This Baton is not for sale right now.</p>
        )}
        <Result notice={notice} />
      </div>
    );
  }

  const canExit = offer && !locked;
  const exitNet = offer ? (offer.price * (10_000n - BigInt(fee))) / 10_000n : 0n;
  const ready = status === 'Ready to withdraw';
  const claimable = BigInt(baton.liquid) > 0n && !BigInt(baton.staked) && !BigInt(baton.unstaked);

  return (
    <div className="panel">
      {locked && <p className="moving">Finishing an action. This Baton cannot change hands until it ends.</p>}

      {canExit && (
        <div className="exit">
          <h3>Exit now</h3>
          <p>A standing offer would pay you <b className="mono">{near(exitNet, 3)} NEAR</b> right now. The stake stays with {shortName(baton.pool)}.</p>
          <button
            className="button wide"
            disabled={!!busy}
            onClick={async () => {
              const before = await view(baton.pool, 'get_total_staked_balance');
              await run('exit', 'baton_fill', { token_id: id, bid_id: offer.bid.id, min_price: ((offer.price * 999n) / 1000n).toString() }, oneYocto, async () => ({
                text: `Sold. ${near(exitNet, 3)} NEAR is in your wallet.`,
                validator: { name: shortName(baton.pool), before, after: await view(baton.pool, 'get_total_staked_balance') },
              }));
            }}
          >
            {busy === 'exit' ? 'Selling…' : `Exit now for ${near(exitNet, 3)} NEAR`}
          </button>
        </div>
      )}

      {listing ? (
        <div className="listed">
          <p>For sale at <b className="mono">{near(listing.price, 2)} NEAR</b>.</p>
          <button className="button ghost small" disabled={!!busy || locked} onClick={() => run('delist', 'baton_delist', { token_id: id }, oneYocto, () => ({ text: 'Taken off sale.' }))}>Take off sale</button>
        </div>
      ) : (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            run('list', 'baton_list', { token_id: id, price: toYocto(price) }, oneYocto, () => ({ text: 'Listed. Anything you do to this Baton now cancels the listing.' }));
          }}
        >
          <label className="field">
            <span>List for sale, in NEAR</span>
            <input className="mono" inputMode="decimal" placeholder={near(worth, 2).replace(/,/g, '')} value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <button className="button ghost" disabled={!!busy || locked || !Number(price)}>{busy === 'list' ? 'Listing…' : 'List'}</button>
        </form>
      )}

      <div className="tools">
        {status === 'Staked' && (
          <button className="link" disabled={!!busy || locked} onClick={() => run('unstake', 'baton_unstake', { token_id: id, amount: null }, oneYocto, () => ({ text: `Unstaking. NEAR will be ready in ${waitText(4)}.` }))}>Unstake all</button>
        )}
        {ready && (
          <button className="button wide" disabled={!!busy || locked} onClick={() => run('withdraw', 'baton_withdraw', { token_id: id }, oneYocto, () => ({ text: 'Withdrawn from the pool to the Baton. Claim it to your wallet next.' }))}>Withdraw to this Baton</button>
        )}
        {(claimable || BigInt(baton.liquid) > 0n) && (
          <button className="button wide" disabled={!!busy || locked} onClick={() => run('claim', 'baton_claim', { token_id: id, amount: null }, oneYocto, (r) => ({ text: `${near(r.value ?? 0, 3)} NEAR paid to your wallet.` }))}>Claim {near(baton.liquid, 3)} NEAR</button>
        )}
        {status !== 'Empty' && (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              run('top', 'baton_stake', { token_id: id }, { deposit: toYocto(topUp), gas: GAS.HIGH }, () => ({ text: 'Added to the stake.' }));
            }}
          >
            <label className="field">
              <span>Add to stake</span>
              <input className="mono" inputMode="decimal" value={topUp} onChange={(e) => setTopUp(e.target.value)} />
            </label>
            <button className="button ghost" disabled={!!busy || locked || !(Number(topUp) >= 0.1)}>Add</button>
          </form>
        )}
      </div>
      <Result notice={notice} />
    </div>
  );
}

function ChainOfTitle({ baton }) {
  const legs = baton.legs;
  const rows = legs.map((leg, index) => {
    const next = legs[index + 1];
    const earned = BigInt(next?.earned_at_start ?? baton.earned) - BigInt(leg.earned_at_start);
    const paid = BigInt(next?.paid_out_at_start ?? baton.paid_out) - BigInt(leg.paid_out_at_start);
    return { ...leg, earned, paid, current: index === legs.length - 1 };
  });
  return (
    <section className="block">
      <div className="section-head">
        <h2>Chain of title</h2>
        <p className="muted">Everyone who has held this Baton, what they paid, and what it earned and paid out while they held it.</p>
      </div>
      {baton.legs_total > legs.length && <p className="muted">{baton.legs_total - legs.length} earlier holders are recorded in the chain's event log.</p>}
      <ol className="legs">
        {rows.map((leg, index) => (
          <li key={`${leg.holder}-${index}`} className={leg.current ? 'current' : ''}>
            <span className="lane-dot" />
            <div>
              <b className="mono">{shortAccount(leg.holder)}</b> {leg.current && <span className="pill green">holds it now</span>}
              <p className="muted">
                Since {dateText(leg.since_ns)}
                {BigInt(leg.price) > 0n ? ` · paid ${near(leg.price, 2)} NEAR` : index === 0 ? ' · first holder' : ' · received as a transfer'}
              </p>
            </div>
            <dl className="leg-figures">
              <div><dt>Earned</dt><dd className="mono good">+{near(leg.earned, 3)}</dd></div>
              <div><dt>Paid out</dt><dd className="mono">{near(leg.paid, 3)}</dd></div>
            </dl>
          </li>
        ))}
      </ol>
    </section>
  );
}

function History({ log }) {
  return (
    <section className="block">
      <h2>History</h2>
      <table className="history">
        <thead>
          <tr><th>When</th><th>What</th><th className="right">NEAR</th><th>Who</th></tr>
        </thead>
        <tbody>
          {[...log].reverse().map((entry, index) => (
            <tr key={index}>
              <td className="muted">{dateText(entry.at_ns)}</td>
              <td>{ENTRY_TEXT[entry.kind] ?? entry.kind}</td>
              <td className="mono right">{BigInt(entry.amount) ? near(entry.amount, 3) : ''}</td>
              <td className="mono muted">{shortAccount(entry.who)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function BatonPage() {
  const { token } = useParams();
  const { user } = useSession();
  const { data, error, loading } = useLive(async () => {
    const [item, nft, bids, config] = await Promise.all([
      view(collection(), 'baton_get', { token_id: token }),
      view(collection(), 'nft_token', { token_id: token }),
      view(collection(), 'baton_bids', {}),
      view(collection(), 'baton_config', {}),
    ]);
    return { item, nft, bids, fee: config.fee_bps };
  }, [token]);

  const item = data?.item;
  const offer = useMemo(() => {
    if (!item) return null;
    return bestOffer(data.bids, worthOf(item.baton), item.epochs_left, item.baton.owner);
  }, [item, data]);

  if (loading) return <p className="empty">Reading the chain…</p>;
  if (error && !data) return <p className="error">Could not reach the chain. {error.message}</p>;
  if (!item) return <p className="empty">There is no Baton with that name.</p>;

  const { baton, status, epochs_left: epochsLeft, listing } = item;
  const worth = worthOf(baton);
  const holder = baton.owner === user;
  const unstaking = status === 'Unbonding';

  return (
    <div className="detail">
      <section className="detail-top">
        <div className="art-column">
          <img className="art" src={data.nft.metadata.media} alt={`The NFT for ${shortName(token)}: ${statusLabel(status)}, holding ${near(worth, 2)} NEAR`} />
          <p className="muted caption">The picture is drawn on-chain from this position's live state. Each lane is one holder.</p>
          <div className="proofs">
            <Link className="button ghost small" to={`/room/${token}`}>Holder room</Link>
            <Link className="button ghost small" to={`/verify/${token}`}>Check it yourself</Link>
          </div>
        </div>

        <div className="info">
          <p className="eyebrow mono">{token}</p>
          <h1>{near(worth, 2)} <small>NEAR</small></h1>
          <div className="row">
            <span className={`pill ${statusTone(status)}`}>{statusLabel(status)}</span>
            <span className="muted">with {shortName(baton.pool)}</span>
            <span className="muted">held by <b className="mono">{holder ? 'you' : shortAccount(baton.owner)}</b></span>
          </div>

          <dl className="figures">
            <Figure label="Staked" value={near(baton.staked, 3)} />
            <Figure label="Unstaking" value={near(baton.unstaked, 3)} tone={unstaking ? 'warn' : ''} hint={unstaking ? `ready in ${waitText(epochsLeft)}` : null} />
            <Figure label="Ready to claim" value={near(baton.liquid, 3)} />
            <Figure label="Earned so far" value={`+${near(baton.earned, 3)}`} tone="good" />
          </dl>

          {listing && <p className="listing-line">For sale at <b className="mono">{near(listing.price, 2)} NEAR</b>, {discount(worth, listing.price).toFixed(2)}% under what it holds.</p>}

          <ActionPanel item={item} offer={offer} fee={data.fee} />
        </div>
      </section>

      <ChainOfTitle baton={baton} />
      <History log={baton.log} />
    </div>
  );
}
