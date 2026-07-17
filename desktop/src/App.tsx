import { lazy, Suspense, useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { LibraryScreen } from './components/LibraryScreen.js';
import { loadViewer, useLibrary } from './hooks/useLibrary.js';
import { loadSettings, saveSettings, type DesktopSettings } from './settings.js';

const ViewerScreen = lazy(loadViewer);

export function App() {
  const [settings, setSettings] = useState<DesktopSettings>(loadSettings);
  const library = useLibrary(settings);

  useEffect(() => saveSettings(settings), [settings]);

  const { selected, manifestUrl } = library;
  if (library.screen === 'viewer' && selected && manifestUrl) {
    return (
      <Suspense fallback={<div className="viewer-loading"><LoaderCircle className="spin" /><span>Starting GPU viewer</span></div>}>
        <ViewerScreen
          world={selected}
          manifestUrl={manifestUrl}
          settings={settings}
          system={library.system}
          hasThumbnail={Boolean(selected.thumbnailUrl)}
          onThumbnail={(thumbnailUrl) => library.updateWorldThumbnail(selected.path, thumbnailUrl)}
          onBack={library.closeViewer}
        />
      </Suspense>
    );
  }

  return <LibraryScreen library={library} settings={settings} onSettingsChange={setSettings} />;
}
