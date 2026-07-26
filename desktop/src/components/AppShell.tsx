import { useCallback, useRef, useState } from 'react';
import type { LibraryController } from '../hooks/useLibrary.js';
import { useLibraryHotkeys } from '../hooks/useLibraryHotkeys.js';
import type { DesktopSettings } from '../settings.js';
import { LibraryScreen } from './LibraryScreen.js';
import { RendersScreen } from './RendersScreen.js';
import { SettingsSheet } from './SettingsSheet.js';
import { ShortcutsSheet } from './ShortcutsSheet.js';
import { Sidebar } from './Sidebar.js';

type Sheet = 'settings' | 'shortcuts' | null;

/** Chrome shared by every non-viewer screen: navigation, sheets, hotkeys. */
export function AppShell({ library, settings, onSettingsChange }: {
  library: LibraryController;
  settings: DesktopSettings;
  onSettingsChange: (next: DesktopSettings) => void;
}) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const shortcutsButtonRef = useRef<HTMLButtonElement>(null);

  // Closing a sheet returns focus to whatever opened it, so keyboard users
  // land back where they were instead of at the top of the document.
  const openSheet = useRef<Sheet>(null);
  openSheet.current = sheet;
  const closeSheet = useCallback(() => {
    const trigger = openSheet.current === 'settings' ? settingsButtonRef : shortcutsButtonRef;
    trigger.current?.focus({ preventScroll: true });
    setSheet(null);
  }, []);

  const openShortcuts = useCallback(() => setSheet('shortcuts'), []);

  useLibraryHotkeys({
    enabled: !sheet && library.screen === 'library',
    filtered: library.filtered,
    selectedPath: library.selectedPath,
    selectPath: library.selectPath,
    openWorld: library.openWorld,
    actionRef: library.actionRef,
    searchRef,
    sheetOpen: Boolean(sheet),
    closeSheet,
    goTo: library.goTo,
    openShortcuts,
  });

  return (
    <div className="app-shell">
      <Sidebar
        worldCount={library.worlds.length}
        renderCount={library.renders.length}
        screen={library.screen}
        onNavigate={library.goTo}
        settingsButtonRef={settingsButtonRef}
        shortcutsButtonRef={shortcutsButtonRef}
        onOpenSettings={() => setSheet('settings')}
        onOpenShortcuts={openShortcuts}
      />

      {library.screen === 'renders' ? (
        <RendersScreen library={library} settings={settings} />
      ) : (
        <LibraryScreen library={library} settings={settings} searchRef={searchRef} />
      )}

      {sheet === 'settings' && (
        <SettingsSheet settings={settings} system={library.system} onChange={onSettingsChange} onClose={closeSheet} />
      )}
      {sheet === 'shortcuts' && <ShortcutsSheet onClose={closeSheet} />}
    </div>
  );
}
