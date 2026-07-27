import { lazy, Suspense, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { AppShell } from './components/AppShell.js';
import { loadViewer, useLibrary } from './hooks/useLibrary.js';
import { useUpdates } from './hooks/useUpdates.js';
import { loadSettings, saveSettings, type DesktopSettings } from './settings.js';

const ViewerScreen = lazy(loadViewer);

export function App() {
  const [settings, setSettings] = useState<DesktopSettings>(loadSettings);
  const library = useLibrary(settings);
  // Lives here rather than in the shell so an update found while the viewer
  // is open is still waiting in the sidebar afterwards.
  const updates = useUpdates();

  useEffect(() => saveSettings(settings), [settings]);

  const { viewer } = library;
  if (viewer) {
    return (
      <Suspense fallback={<div className="viewer-loading"><LoaderCircle className="spin" /><span>Starting GPU viewer</span></div>}>
        <ViewerScreen
          target={viewer}
          settings={settings}
          system={library.system}
          onThumbnail={(thumbnailUrl) => library.updateWorldThumbnail(viewer.world.path, thumbnailUrl)}
          onBack={library.closeViewer}
        />
      </Suspense>
    );
  }

  return <AppShell library={library} settings={settings} updates={updates} onSettingsChange={setSettings} />;
}
