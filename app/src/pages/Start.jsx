import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../App.jsx';
import { GAS, act, view } from '../api.js';
import { explainError, near, shortName, toYocto } from '../format.js';
import { useLive } from '../hooks.js';

const OVERHEAD = 60_000_000_000_000_000_000_000n; // 0.06 NEAR: account and record storage

export function Start() {
  const { config, user, refresh } = useSession();
  const navigate = useNavigate();
  const [pool, setPool] = useState(null);
  const [amount, setAmount] = useState('10');
  const [gift, setGift] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const { data: pools } = useLive(
    () =>
      Promise.all(
        config.pools.map(async (id) => {
          const [fee, staked] = await Promise.all([view(id, 'get_reward_fee_fraction'), view(id, 'get_total_staked_balance')]);
          return { id, fee: (fee.numerator * 100) / fee.denominator, staked };
        }),
      ),
    [],
    20000,
  );
  const sorted = [...(pools ?? [])].sort((a, b) => a.fee - b.fee);
  const chosen = pool ?? sorted[0]?.id;
  const valid = Number(amount) >= 1;

  const start = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const deposit = (BigInt(toYocto(amount)) + OVERHEAD).toString();
      const result = await act(user, 'baton_mint', { pool: chosen, receiver_id: gift.trim() || null }, { deposit, gas: GAS.HIGH });
      const minted = result.events?.find((e) => e.event === 'nft_mint');
      if (result.value === true && minted) {
        refresh();
        navigate(`/b/${minted.data[0].token_ids[0]}`);
      } else {
        setError(explainError(result));
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="narrow">
      <p className="eyebrow">New position</p>
      <h1>Start a Baton</h1>
      <p className="lede">Your NEAR is staked with the validator you pick, from a new account that only this NFT controls.</p>

      <form onSubmit={start} className="form">
        <fieldset>
          <legend>Validator</legend>
          <div className="pool-list">
            {sorted.map((p) => (
              <label key={p.id} className={`pool ${chosen === p.id ? 'selected' : ''}`}>
                <input type="radio" name="pool" value={p.id} checked={chosen === p.id} onChange={() => setPool(p.id)} />
                <span className="pool-name">{shortName(p.id)}</span>
                <span className="mono muted">{p.fee}% commission</span>
                <span className="mono muted">{near(p.staked, 0)} NEAR staked</span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>Amount to stake, in NEAR</span>
          <input className="mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby="amount-help" />
          <small id="amount-help">At least 1 NEAR. Setup adds 0.06 NEAR for the account and its record.</small>
        </label>

        <label className="field">
          <span>Give it to someone else <em>optional</em></span>
          <input className="mono" value={gift} placeholder="their-account.near" onChange={(e) => setGift(e.target.value)} autoComplete="off" spellCheck="false" />
          <small>They become the holder from the start.</small>
        </label>

        {error && <p className="error">{error}</p>}
        <button className="button wide" disabled={busy || !user || !chosen || !valid}>
          {busy ? 'Creating your Baton…' : `Stake ${amount || 0} NEAR`}
        </button>
      </form>
    </section>
  );
}
