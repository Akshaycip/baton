import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '../App.jsx';
import { enterRoom, issueKey, openRoom, roomApi, useKey } from '../api.js';
import { shortAccount, shortName } from '../format.js';

const storageKey = (user, token) => `baton.room.${user}.${token}`;
const load = (key) => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};
const save = (key, value) => {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Without storage the room simply asks for a signature again. */
  }
};

function reasonText(error, token) {
  const name = shortName(token);
  if (error.error === 'not_the_holder') return `This room belongs to ${shortAccount(error.holder)}, the current holder of ${name}.`;
  if (error.error === 'no_such_baton') return 'There is no Baton with that name.';
  return `Could not open the room: ${error.message}`;
}

export function Room() {
  const { token } = useParams();
  const { user, revision } = useSession();
  const [entry, setEntry] = useState(() => load(storageKey(user, token)));
  const [contents, setContents] = useState(null);
  const [refused, setRefused] = useState(null);
  const [busy, setBusy] = useState(false);
  const [keyResult, setKeyResult] = useState(null);

  useEffect(() => {
    setEntry(load(storageKey(user, token)));
    setContents(null);
    setRefused(null);
    setKeyResult(null);
  }, [user, token]);

  useEffect(() => {
    let live = true;
    if (!entry?.session) return undefined;
    openRoom(token, entry.session)
      .then((data) => {
        if (!live) return;
        setContents(data);
        setRefused(null);
      })
      .catch((error) => {
        if (!live) return;
        setContents(null);
        setRefused(error);
      });
    return () => {
      live = false;
    };
  }, [entry, token, revision]);

  const remember = (next) => {
    save(storageKey(user, token), next);
    setEntry(next);
  };

  const signIn = async () => {
    setBusy(true);
    setRefused(null);
    try {
      remember({ ...entry, session: await enterRoom(user, token) });
    } catch (error) {
      setRefused(error);
    } finally {
      setBusy(false);
    }
  };

  const makeKey = async () => {
    const { apiKey } = await issueKey(token, entry.session);
    remember({ ...entry, apiKey });
    setContents((c) => ({ ...c, apiKey }));
  };

  const tryKey = async () => {
    try {
      setKeyResult({ ok: true, body: await useKey(entry.apiKey) });
    } catch (error) {
      setKeyResult({ ok: false, body: { error: error.error, status: error.status } });
    }
  };

  const noServer = !roomApi() && !contents && window.location.protocol === 'https:' && window.location.host.includes('fastfs');

  return (
    <section className="narrow">
      <p className="eyebrow mono">{token}</p>
      <h1>Holder room</h1>
      <p className="lede">Only the current holder of this Baton can open this page. It asks the chain who holds it on every visit, so the moment a Baton is sold the old holder is out.</p>

      {noServer && <p className="notice">The holder room needs a small server, which this static copy of the app does not have. Run the app from the repository to open it (see the README).</p>}

      {!contents && !noServer && (
        <div className="door">
          <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="10" y="20" width="28" height="22" rx="4" /><path d="M16 20v-6a8 8 0 0 1 16 0v6" fill="none" /></svg>
          {refused && <p className="error" role="alert">{reasonText(refused, token)}</p>}
          <button className="button" disabled={busy || !user} onClick={signIn}>{busy ? 'Waiting for signature…' : 'Sign to enter'}</button>
          <p className="muted">Signing costs nothing and moves no NEAR. It only proves which account you are.</p>
          {entry?.apiKey && (
            <div className="key-box">
              <p className="muted">You kept an API key from when you held this Baton.</p>
              <button className="button ghost small" onClick={tryKey}>Try my old key</button>
              {keyResult && <pre className={keyResult.ok ? '' : 'pre-bad'}>{JSON.stringify(keyResult.body, null, 2)}</pre>}
            </div>
          )}
        </div>
      )}

      {contents && (
        <div className="room">
          <p className="ok">Welcome. The chain confirms you hold this Baton right now.</p>

          <h2>From your validator</h2>
          {contents.notes.map((note) => (
            <article key={note.title} className="note">
              <h3>{note.title}</h3>
              <p>{note.body}</p>
              <small className="muted">{note.from}{note.sample ? ' · sample notice' : ''}</small>
            </article>
          ))}

          <h2>Your delegator API key</h2>
          <p>Private RPC access for whoever holds this Baton. The key works only while you do.</p>
          {contents.apiKey || entry?.apiKey ? (
            <div className="key-box">
              <code className="mono">{contents.apiKey ?? entry.apiKey}</code>
              <button className="button ghost small" onClick={tryKey}>Test the key</button>
              {keyResult && <pre className={keyResult.ok ? '' : 'pre-bad'}>{JSON.stringify(keyResult.body, null, 2)}</pre>}
            </div>
          ) : (
            <button className="button ghost" onClick={makeKey}>Create my key</button>
          )}
        </div>
      )}

      <p><Link to={`/b/${token}`}>Back to this Baton</Link></p>
    </section>
  );
}
