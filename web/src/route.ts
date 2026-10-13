import { useEffect, useState } from 'react';

/** Where you are: a project's cockpit or rules, or the projects overview. Kept in the URL hash, so Back and bookmarks work. */
export type Route = { view: 'cockpit' | 'rules' | 'projects'; project: string | null };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  if (h === 'projects') return { view: 'projects', project: null };
  const m = h.match(/^p\/([^/]+)(\/rules)?$/);
  if (m) return { view: m[2] ? 'rules' : 'cockpit', project: decodeURIComponent(m[1]) };
  if (h === 'rules') return { view: 'rules', project: null }; // before projects existed
  return { view: 'cockpit', project: null };
}

export const projectHref = (name: string, view: 'cockpit' | 'rules' = 'cockpit') => `#/p/${encodeURIComponent(name)}${view === 'rules' ? '/rules' : ''}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

/** The project you last had open, for a bare URL. */
export const lastProject = {
  get: (): string | null => {
    try {
      return localStorage.getItem('forge.project');
    } catch {
      return null;
    }
  },
  set: (name: string) => {
    try {
      localStorage.setItem('forge.project', name);
    } catch {
      /* private window: fine, the server's default project opens */
    }
  },
};
