import { useCallback, useEffect, useState } from 'react';
import { loadJson, saveJson } from '../lib/storage';

/** useState persisted to localStorage. */
export function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => loadJson(key, initial));
  useEffect(() => saveJson(key, value), [key, value]);
  return [value, setValue] as const;
}

/** Tiny hash router: "#/resume" → "resume". */
export function useRoute(): [string, (r: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('?')[0];
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((r: string) => {
    window.location.hash = r ? `/${r}` : '';
  }, []);
  return [route, go];
}
