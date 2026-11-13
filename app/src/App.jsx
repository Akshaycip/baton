import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { accountInfo, canSkipTime, connectWallet, disconnectWallet, onWalletChange, resetLocal, restoreWallet, skipEpochs } from './api.js';
import { near } from './format.js';
import { BatonPage } from './pages/BatonPage.jsx';
import { Market } from './pages/Market.jsx';
import { Mine } from './pages/Mine.jsx';
import { Offers } from './pages/Offers.jsx';
import { Room } from './pages/Room.jsx';
import { Start } from './pages/Start.jsx';
import { Verify } from './pages/Verify.jsx';

const Session = createContext(null);
export const useSession = () => useContext(Session);

function readStoredPersona(personas) {
  try {
    const saved = localStorage.getItem('baton.persona');
    return personas.some((p) => p.id === saved) ? saved : null;
  } catch {
    return null;
  }
}

function PracticeBar() {
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const run = (task) => async () => {
    setBusy(true);
    try {
      await task();
      refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="practice">
      <span>
        <strong>Practice chain.</strong> Real contracts and real staking pool code on this computer. Sample data, no real NEAR.
      </span>
      <span className="practice-actions">
        <button disabled={busy} onClick={run(() => skipEpochs(1))}>Skip 7 hours</button>
        <button disabled={busy} onClick={run(() => skipEpochs(100))}>Skip 30 days</button>
        <button disabled={busy} onClick={run(resetLocal)}>Reset</button>
      </span>
    </div>
  );
}

function Account() {
  const { config, user, setUser, revision } = useSession();
  const [balance, setBalance] = useState(null);

  useEffect(() => {
    let live = true;
    if (!user) return setBalance(null);
    accountInfo(user).then((info) => live && setBalance(info.balance ?? null)).catch(() => {});
    return () => {
      live = false;
    };
  }, [user, revision]);

  if (config.signer === 'server') {
    return (
      <label className="persona">
        <span>You are</span>
        <select value={user ?? ''} onChange={(e) => setUser(e.target.value)} aria-label="Act as">
          {config.personas.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        {balance !== null && <b className="mono">{near(balance, 2)} NEAR</b>}
      </label>
    );
  }
  if (!user) {
    return <button className="button small" onClick={() => connectWallet().then(setUser).catch(() => {})}>Connect wallet</button>;
  }
  return (
    <div className="persona">
      <span className="mono">{user}</span>
      {balance !== null && <b className="mono">{near(balance, 2)} NEAR</b>}
      <button className="link" onClick={() => disconnectWallet().then(() => setUser(null))}>Disconnect</button>
    </div>
  );
}

function Header() {
  const { config } = useSession();
  const links = [
    ['/', 'Market'],
    ['/start', 'Start a Baton'],
    ['/offers', 'Offers'],
    ['/mine', 'My Batons'],
  ];
  return (
    <header className="header">
      <NavLink to="/" className="brand" aria-label="Baton home">
        <svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="var(--signal)" /><rect x="27" y="14" width="10" height="36" rx="5" fill="#fff" transform="rotate(35 32 32)" /></svg>
        Baton
        {config.network === 'testnet' && <span className="chip">NEAR testnet</span>}
      </NavLink>
      <nav>
        {links.map(([to, label]) => (
          <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>
        ))}
      </nav>
      <Account />
    </header>
  );
}

export function App({ config }) {
  const [user, setUserState] = useState(() => (config.signer === 'server' ? (readStoredPersona(config.personas) ?? config.personas[0]?.id ?? null) : null));
  const [revision, setRevision] = useState(0);

  const setUser = useCallback((id) => {
    setUserState(id);
    try {
      if (id) localStorage.setItem('baton.persona', id);
    } catch {
      /* Only a convenience. */
    }
  }, []);

  useEffect(() => {
    if (config.signer !== 'wallet') return undefined;
    restoreWallet().then(setUserState);
    return onWalletChange(setUserState);
  }, [config.signer]);

  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  const value = useMemo(() => ({ config, user, setUser, revision, refresh }), [config, user, setUser, revision, refresh]);

  return (
    <Session.Provider value={value}>
      <HashRouter>
        {canSkipTime() && <PracticeBar />}
        <Header />
        <main>
          <Routes>
            <Route path="/" element={<Market />} />
            <Route path="/start" element={<Start />} />
            <Route path="/offers" element={<Offers />} />
            <Route path="/mine" element={<Mine />} />
            <Route path="/b/:token" element={<BatonPage />} />
            <Route path="/room/:token" element={<Room />} />
            <Route path="/verify/:token" element={<Verify />} />
          </Routes>
        </main>
        <footer className="footer">
          <span>Baton is unaudited hackathon software. Validators can change commission or go offline.</span>
          <a href="https://github.com/near/NEPs/blob/master/neps/nep-0171.md" target="_blank" rel="noreferrer">NEP-171</a>
        </footer>
      </HashRouter>
    </Session.Provider>
  );
}
