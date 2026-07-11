import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Landing } from './Landing.js';

// The viewer pulls in three.js — keep it out of the landing page's bundle.
const ViewerApp = lazy(() => import('./ViewerApp.js').then((m) => ({ default: m.ViewerApp })));

/** Where the Pages workflow publishes the demo render, relative to the site. */
export const DEMO_MANIFEST = 'demo/manifest.json';

// ?world=demo in the query string enters the viewer; the hash stays owned by
// the viewer's camera deep links (#@x,y,z,…), so a shared demo link restores
// both the mode and the exact view.
function demoFromUrl(): boolean {
  return new URLSearchParams(window.location.search).get('world') === 'demo';
}

function pushUrl(demo: boolean): void {
  const url = new URL(window.location.href);
  url.hash = '';
  if (demo) url.searchParams.set('world', 'demo');
  else url.searchParams.delete('world');
  history.pushState(null, '', url);
}

export function App() {
  const [demo, setDemo] = useState<boolean>(demoFromUrl);

  useEffect(() => {
    const onPop = () => setDemo(demoFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openDemo = useCallback(() => {
    pushUrl(true);
    setDemo(true);
  }, []);

  const exitViewer = useCallback(() => {
    pushUrl(false);
    setDemo(false);
  }, []);

  if (demo) {
    return (
      <Suspense fallback={<div className="viewer-loading">loading the viewer…</div>}>
        <ViewerApp world={DEMO_MANIFEST} label="demo world" onExit={exitViewer} />
      </Suspense>
    );
  }
  return <Landing onDemo={openDemo} />;
}
