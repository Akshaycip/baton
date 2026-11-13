import { useEffect, useState } from 'react';
import { useSession } from './App.jsx';

/** Loads `load()` now, again every few seconds, and again after any action in the app. */
export function useLive(load, deps = [], everyMs = 4000) {
  const { revision } = useSession();
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const data = await load();
        if (live) setState({ data });
      } catch (error) {
        if (live) setState((previous) => ({ ...previous, loading: false, error }));
      }
    };
    tick();
    const timer = setInterval(tick, everyMs);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, revision]);

  return state;
}
