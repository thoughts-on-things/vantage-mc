import { useEffect, type RefObject } from 'react';
import type { WorldInfo } from '../bridge.js';
import type { WorldAction } from '../lib/format.js';

interface HotkeyOptions {
  enabled: boolean;
  filtered: WorldInfo[];
  selectedPath: string | null;
  selectPath: (path: string) => void;
  openWorld: (world: WorldInfo) => Promise<void>;
  actionRef: RefObject<WorldAction | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  settingsOpen: boolean;
  closeSettings: () => void;
}

/**
 * Library keyboard model: Ctrl+K or / focuses search, arrows move the world
 * selection, Enter opens it, Escape closes the settings sheet. Everything is
 * suspended while a world action holds the lock.
 */
export function useLibraryHotkeys({ enabled, filtered, selectedPath, selectPath, openWorld, actionRef, searchRef, settingsOpen, closeSettings }: HotkeyOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select, [contenteditable="true"]');
      if (((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k') || (event.key === '/' && !typing)) {
        if (actionRef.current) return;
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (event.key === 'Escape' && settingsOpen) {
        event.preventDefault();
        closeSettings();
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
  }, [actionRef, closeSettings, enabled, filtered, openWorld, searchRef, selectedPath, selectPath, settingsOpen]);
}
