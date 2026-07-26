import { useEffect, type RefObject } from 'react';
import type { WorldInfo } from '../bridge.js';
import type { WorldAction } from '../lib/format.js';
import type { Screen } from './useLibrary.js';

interface HotkeyOptions {
  enabled: boolean;
  filtered: WorldInfo[];
  selectedPath: string | null;
  selectPath: (path: string) => void;
  openWorld: (world: WorldInfo) => Promise<void>;
  actionRef: RefObject<WorldAction | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  sheetOpen: boolean;
  closeSheet: () => void;
  goTo: (screen: Screen) => void;
  openShortcuts: () => void;
}

/**
 * Library keyboard model: Ctrl+K or / focuses search, Ctrl+1/Ctrl+2 switch
 * screens, ? opens the shortcut sheet, arrows move the world selection, Enter
 * opens it, Escape closes an open sheet. Everything that touches a world is
 * suspended while an action holds the lock.
 */
export function useLibraryHotkeys({
  enabled,
  filtered,
  selectedPath,
  selectPath,
  openWorld,
  actionRef,
  searchRef,
  sheetOpen,
  closeSheet,
  goTo,
  openShortcuts,
}: HotkeyOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]');
      // An aria-modal sheet owns the keyboard while it is open. In
      // particular, Ctrl+K must not pull focus into the search field behind
      // the dialog; only Escape is allowed to leave the sheet.
      if (sheetOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSheet();
        }
        return;
      }
      if (((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') || (event.key === '/' && !typing)) {
        if (actionRef.current) return;
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && (event.key === '1' || event.key === '2')) {
        if (actionRef.current) return;
        event.preventDefault();
        goTo(event.key === '1' ? 'library' : 'renders');
        return;
      }
      if (event.key === '?' && !typing) {
        event.preventDefault();
        openShortcuts();
        return;
      }
      if (typing || !enabled || !filtered.length || actionRef.current) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
        const current = Math.max(0, filtered.findIndex((world) => world.path === selectedPath));
        const next = (current + direction + filtered.length) % filtered.length;
        selectPath(filtered[next].path);
        requestAnimationFrame(() => {
          const card = document.querySelector<HTMLElement>(`[data-world-index="${next}"]`);
          card?.focus({ preventScroll: true });
          card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      } else if (event.key === 'Enter' && !target?.closest('button, [role="button"]')) {
        const world = filtered.find((candidate) => candidate.path === selectedPath) ?? filtered[0];
        event.preventDefault();
        void openWorld(world);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actionRef, closeSheet, enabled, filtered, goTo, openShortcuts, openWorld, searchRef, selectedPath, selectPath, sheetOpen]);
}
