import { Link } from 'react-router-dom';
import { useSession } from '../App.jsx';
import { collection, view } from '../api.js';
import { near, shortName, statusLabel, statusTone, worthOf } from '../format.js';
import { useLive } from '../hooks.js';

export function Mine() {
  const { user } = useSession();
  const { data } = useLive(async () => {
    if (!user) return [];
    const [items, nfts] = await Promise.all([view(collection(), 'baton_of', { account_id: user }), view(collection(), 'nft_tokens_for_owner', { account_id: user })]);
    const art = Object.fromEntries(nfts.map((t) => [t.token_id, t.metadata.media]));
    return items.map((item) => ({ ...item, art: art[item.token_id] }));
  }, [user]);

  return (
    <section className="wide-section">
      <h1>My Batons</h1>
      {!user && <p className="empty">Connect a wallet to see your Batons.</p>}
      {data?.length === 0 && user && (
        <p className="empty">You do not hold any Batons yet. <Link to="/start">Start one</Link>, or buy one from the market.</p>
      )}
      <div className="cards">
        {data?.map((item) => (
          <Link key={item.token_id} to={`/b/${item.token_id}`} className="card">
            <img src={item.art} alt="" />
            <div className="card-body">
              <b className="mono">{near(worthOf(item.baton), 2)} NEAR</b>
              <span className={`pill ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
              <p className="muted">{shortName(item.baton.pool)}, +{near(item.baton.earned, 3)} earned</p>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
