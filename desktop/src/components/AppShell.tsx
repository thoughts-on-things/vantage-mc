import { useCallback, useRef, useState } from 'react';
import type { HostsController } from '../hooks/useHosts.js';
import type { LibraryController } from '../hooks/useLibrary.js';
import { useLibraryHotkeys } from '../hooks/useLibraryHotkeys.js';
import type { UpdatesController } from '../hooks/useUpdates.js';
import type { DesktopSettings } from '../settings.js';
import { LibraryScreen } from './LibraryScreen.js';
import { RendersScreen } from './RendersScreen.js';
import { ServersScreen } from './ServersScreen.js';
import { SettingsSheet } from './SettingsSheet.js';
import { ShortcutsSheet } from './ShortcutsSheet.js';
import { Sidebar } from './Sidebar.js';

type Sheet = 'settings' | 'shortcuts' | null;

/** Chrome shared by every non-viewer screen: navigation, sheets, hotkeys. */
export function AppShell({ library, hosts, settings, updates, onSettingsChange }: {
  library: LibraryController;
  hosts: HostsController;
  settings: DesktopSettings;
  updates: UpdatesController;
  onSettingsChange: (next: DesktopSettings) => void;
}) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const shortcutsButtonRef = useRef<HTMLButtonElement>(null);
  const sheetOpenerRef = useRef<HTMLElement | null>(null);

  // Closing a sheet returns focus to whatever opened it, so keyboard users
  // land back where they were instead of at the top of the document.
  const activeSheetRef = useRef<Sheet>(null);
  activeSheetRef.current = sheet;
  const showSheet = useCallback((next: Exclude<Sheet, null>) => {
    const active = document.activeElement;
    sheetOpenerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setSheet(next);
  }, []);
  const closeSheet = useCallback(() => {
    const fallback = activeSheetRef.current === 'settings' ? settingsButtonRef : shortcutsButtonRef;
    const opener = sheetOpenerRef.current;
    (opener?.isConnected ? opener : fallback.current)?.focus({ preventScroll: true });
    sheetOpenerRef.current = null;
    setSheet(null);
  }, []);

  const openShortcuts = useCallback(() => showSheet('shortcuts'), [showSheet]);

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
        serverCount={hosts.hosts.length}
        screen={library.screen}
        updates={updates}
        onNavigate={library.goTo}
        settingsButtonRef={settingsButtonRef}
        shortcutsButtonRef={shortcutsButtonRef}
        onOpenSettings={() => showSheet('settings')}
        onOpenShortcuts={openShortcuts}
      />

      {library.screen === 'renders' ? (
        <RendersScreen library={library} settings={settings} />
      ) : library.screen === 'servers' ? (
        <ServersScreen hosts={hosts} library={library} />
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
