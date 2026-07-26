import { Fragment, useEffect, useRef, type KeyboardEvent } from 'react';
import { Keyboard, X } from 'lucide-react';

/** Each row lists the keys that do the same thing, then what they do. */
const GROUPS: { title: string; rows: [string[], string][] }[] = [
  {
    title: 'Library',
    rows: [
      [['Ctrl K', '/'], 'Search worlds'],
      [['← ↑ → ↓'], 'Move between worlds'],
      [['Enter'], 'Open or render the selected world'],
      [['Double-click'], 'Open a world instantly'],
    ],
  },
  {
    title: 'Navigate',
    rows: [
      [['Ctrl 1'], 'Worlds'],
      [['Ctrl 2'], 'Renders'],
      [['?'], 'This shortcut list'],
      [['Esc'], 'Close a panel or leave the viewer'],
    ],
  },
  {
    title: 'In the map',
    rows: [
      [['Drag'], 'Pan'],
      [['Right-drag'], 'Orbit'],
      [['Scroll'], 'Zoom'],
      [['C'], 'Cave depth slice'],
      [['B'], 'Biome layer'],
    ],
  },
];

export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const sheetRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);

  const keepFocusInside = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const controls = sheetRef.current?.querySelectorAll<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className="settings-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={sheetRef} className="settings-sheet shortcuts-sheet" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onKeyDown={keepFocusInside}>
        <header className="settings-head">
          <div><p className="eyebrow">Keyboard</p><h2 id="shortcuts-title">Shortcuts</h2></div>
          <button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close shortcuts"><X size={18} /></button>
        </header>
        <div className="settings-body">
          {GROUPS.map((group) => (
            <section key={group.title} className="settings-group">
              <div className="settings-group-title"><Keyboard size={16} /><div><h3>{group.title}</h3></div></div>
              <dl className="shortcut-list">
                {group.rows.map(([keys, meaning]) => (
                  <div key={meaning}>
                    <dt>
                      {keys.map((key, index) => (
                        <Fragment key={key}>
                          {index > 0 && <span className="key-or">or</span>}
                          <kbd>{key}</kbd>
                        </Fragment>
                      ))}
                    </dt>
                    <dd>{meaning}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer className="settings-foot"><span><i /> Shortcuts pause while a world is rendering</span><button className="primary-button compact" onClick={onClose}>Done</button></footer>
      </section>
    </div>
  );
}
