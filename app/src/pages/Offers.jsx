import { useState } from 'react';
import { useSession } from '../App.jsx';
import { GAS, act, collection, view } from '../api.js';
import { explainError, near, shortAccount, toYocto, waitText } from '../format.js';
import { useLive } from '../hooks.js';

const BID_STORAGE = 5_000_000_000_000_000_000_000n; // 0.005 NEAR, returned when the offer closes

export function Offers() {
  const { user, refresh } = useSession();
  const { data: bids } = useLive(() => view(collection(), 'baton_bids', {}));
  const [amount, setAmount] = useState('50');
  const [percent, setPercent] = useState('0.4');
  const [epochs, setEpochs] = useState(4);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const place = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const discount = Math.round(Number(percent) * 100);
      const result = await act(user, 'baton_bid', { discount_bps: discount, max_epochs: Number(epochs) }, { deposit: (BigInt(toYocto(amount)) + BID_STORAGE).toString(), gas: GAS.LOW });
      setMessage(result.ok ? { tone: 'ok', text: 'Your offer is live. Holders can sell into it in one transaction.' } : { tone: 'error', text: explainError(result) });
      refresh();
    } catch (failure) {
      setMessage({ tone: 'error', text: failure.message });
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id) => {
    const result = await act(user, 'baton_bid_cancel', { bid_id: id }, { gas: GAS.LOW });
    setMessage(result.ok ? { tone: 'ok', text: 'Offer closed. Your NEAR is back in your wallet.' } : { tone: 'error', text: explainError(result) });
    refresh();
  };

  return (
    <section className="narrow">
      <p className="eyebrow">Earn by waiting</p>
      <h1>Standing offers</h1>
      <p className="lede">Leave NEAR ready to buy positions at a small discount. A holder who wants out sells to you instantly, you wait out the unstaking, and you keep the difference.</p>

      <form className="form" onSubmit={place}>
        <label className="field">
          <span>NEAR to set aside</span>
          <input className="mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          <span>Discount you want, in percent</span>
          <input className="mono" inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} />
        </label>
        <label className="field">
          <span>Longest you will wait for your NEAR</span>
          <select value={epochs} onChange={(e) => setEpochs(e.target.value)}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{n === 4 ? `${waitText(4)} (includes staked positions)` : waitText(n)}</option>
            ))}
          </select>
        </label>
        {message && <p className={message.tone}>{message.text}</p>}
        <button className="button wide" disabled={busy || !user || !(Number(amount) >= 0.1)}>{busy ? 'Placing…' : `Place offer of ${amount || 0} NEAR`}</button>
      </form>

      <h2>Open offers</h2>
      {bids?.length === 0 && <p className="empty">No open offers.</p>}
      <ul className="offers">
        {bids?.map((bid) => (
          <li key={bid.id}>
            <div>
              <b className="mono">{near(bid.remaining, 2)} NEAR</b>
              <p className="muted">{(bid.discount_bps / 100).toFixed(2)}% discount, waits up to {waitText(bid.max_epochs)}</p>
            </div>
            {bid.bidder === user ? <button className="button ghost small" onClick={() => cancel(bid.id)}>Close</button> : <span className="muted mono">{shortAccount(bid.bidder)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
