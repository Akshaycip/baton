import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../App.jsx';
import { act, collection, view } from '../api.js';
import { discount, explainError, near, shortName, statusLabel, statusTone, waitText, worthOf } from '../format.js';
import { useLive } from '../hooks.js';

function Track() {
  return (
    <figure className="track" aria-hidden="true">
      <svg viewBox="0 0 460 280">
        {[0, 1, 2, 3].map((lane) => (
          <rect key={lane} x={12 + lane * 26} y={12 + lane * 26} width={436 - lane * 52} height={256 - lane * 52} rx={128 - lane * 26} className={lane === 3 ? 'lane now' : 'lane'} />
        ))}
        <g className="baton">
          <rect x="-16" y="-5" width="32" height="10" rx="5" />
        </g>
        <text x="230" y="134" textAnchor="middle" className="track-big">Stake keeps running</text>
        <text x="230" y="158" textAnchor="middle" className="track-small">only the holder changes</text>
      </svg>
    </figure>
  );
}

function Hero({ listings, bids }) {
  const forSale = listings.reduce((total, l) => total + worthOf(l.baton), 0n);
  const ready = bids.reduce((total, b) => total + BigInt(b.remaining), 0n);
  return (
    <section className="hero">
      <div>
        <p className="eyebrow">NFTs that do something</p>
        <h1>Sell your NEAR stake without unstaking.</h1>
        <p className="lede">
          A Baton is an NFT that is also a real NEAR account, staked with a real validator. Sell the NFT and the stake, its rewards and its access go to the buyer in one transaction. Nothing unstakes, and the validator keeps every NEAR.
        </p>
        <div className="row">
          <Link className="button" to="/start">Start a Baton</Link>
          <a className="button ghost" href="#how">How it works</a>
        </div>
      </div>
      <div className="hero-side">
        <Track />
        <dl className="stats">
          <div><dt>Staked and for sale</dt><dd className="mono">{near(forSale, 0)} <small>NEAR</small></dd></div>
          <div><dt>Waiting to buy</dt><dd className="mono">{near(ready, 0)} <small>NEAR</small></dd></div>
          <div><dt>Time to exit</dt><dd>One transaction</dd></div>
        </dl>
      </div>
    </section>
  );
}

function Row({ item, art, onBought }) {
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { baton, listing, status, epochs_left: epochsLeft, token_id: id } = item;
  const worth = worthOf(baton);
  const unstaking = status === 'Unbonding';
  const mine = baton.owner === user;

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await act(user, 'baton_buy', { token_id: id, listing_id: listing.id }, { deposit: listing.price });
      if (result.ok && !result.failures?.length) onBought(id);
      else setError(explainError(result));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="board-row">
      <Link to={`/b/${id}`} className="thumb" aria-label={`Open ${shortName(id)}`}>{art ? <img src={art} alt="" /> : <span className="thumb-empty" />}</Link>
      <div className="board-main">
        <Link to={`/b/${id}`} className="board-title">{shortName(baton.pool)}</Link>
        <span className={`pill ${statusTone(status)}`}>{statusLabel(status)}</span>
        <p className="muted">{unstaking ? `NEAR arrives in ${waitText(epochsLeft)}` : 'Earning rewards now'}</p>
      </div>
      <dl className="board-cell"><dt>Holds</dt><dd className="mono">{near(worth, 3)}</dd></dl>
      <dl className="board-cell"><dt>Price</dt><dd className="mono">{near(listing.price, 3)}</dd></dl>
      <dl className="board-cell">
        <dt>{unstaking ? 'You make by waiting' : 'Below what it holds'}</dt>
        <dd className="mono good">{unstaking ? `+${near(worth - BigInt(listing.price), 3)}` : `${discount(worth, listing.price).toFixed(2)}%`}</dd>
      </dl>
      <div className="board-action">
        {mine ? (
          <Link to={`/b/${id}`} className="button ghost small">Yours</Link>
        ) : (
          <button className="button small" disabled={busy || !user} onClick={buy}>{busy ? 'Buying…' : 'Buy'}</button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </article>
  );
}

function How() {
  const steps = [
    ['Stake through a Baton', 'You choose any validator. Baton creates a new NEAR account just for this stake and delegates from it. That account has no keys. Only the NFT controls it.'],
    ['It works like normal staking', 'The validator sees one more delegator. Rewards build up as usual, and the NFT redraws itself to show them.'],
    ['Sell whenever you want', 'List it, or take a standing offer for an instant exit. The new holder takes over the account. Your access ends in the same transaction.'],
  ];
  return (
    <section className="how" id="how">
      <h2>How it works</h2>
      <ol className="steps">
        {steps.map(([title, body], index) => (
          <li key={title}>
            <span className="step-number mono">{index + 1}</span>
            <h3>{title}</h3>
            <p>{body}</p>
          </li>
        ))}
      </ol>
      <div className="compare">
        <h3>Why not unstake or use a liquid staking token?</h3>
        <table>
          <thead>
            <tr><th></th><th>Unstake</th><th>Liquid staking token</th><th>Baton</th></tr>
          </thead>
          <tbody>
            <tr><th>Exit time</th><td>Up to 28 hours</td><td>Instant, if the market is deep</td><td>One transaction</td></tr>
            <tr><th>Your validator keeps the stake</th><td>No</td><td>You never chose one</td><td>Yes</td></tr>
            <tr><th>Your money is in</th><td>Your own delegation</td><td>A shared pool</td><td>Its own account</td></tr>
            <tr><th>Works with</th><td>Any validator</td><td>The issuer's list</td><td>Any validator, today</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Market() {
  const navigate = useNavigate();
  const { refresh } = useSession();
  const { data, error } = useLive(async () => {
    const [listings, bids] = await Promise.all([view(collection(), 'baton_listings', {}), view(collection(), 'baton_bids', {})]);
    const tokens = await Promise.all(listings.map((l) => view(collection(), 'nft_token', { token_id: l.token_id })));
    return { listings, bids, art: Object.fromEntries(tokens.map((t) => [t.token_id, t.metadata.media])) };
  });
  const listings = data?.listings ?? [];
  const sorted = [...listings].sort((a, b) => Number(a.epochs_left) - Number(b.epochs_left));

  return (
    <>
      <Hero listings={listings} bids={data?.bids ?? []} />
      <section className="board">
        <div className="section-head">
          <h2>For sale now</h2>
          <p className="muted">Live stake and NEAR that is already unstaking. Buying unstaking NEAR at a discount pays you for waiting.</p>
        </div>
        {error && !data && <p className="error">Could not reach the chain. {error.message}</p>}
        {data && sorted.length === 0 && <p className="empty">Nothing is for sale right now. <Link to="/start">Start a Baton</Link>.</p>}
        {sorted.map((item) => (
          <Row key={item.token_id} item={item} art={data.art[item.token_id]} onBought={(id) => { refresh(); navigate(`/b/${id}`); }} />
        ))}
      </section>
      <How />
    </>
  );
}
