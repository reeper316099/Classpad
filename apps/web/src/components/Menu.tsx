import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  id: string;
  label: string;
  /** A short glyph shown in a square on the left (like Notion's block icons). */
  glyph?: string;
  /** Muted text on the right (a shortcut). */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  /** A heading row above this item. */
  section?: string;
  onSelect?: () => void;
  children?: MenuItem[];
}

interface Props {
  /** Where to open (viewport coordinates). */
  at: { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
  label: string;
  /** Keep keyboard focus where it was (menus opened from the editor must not steal the caret until used). */
  autoFocus?: boolean;
  /** For submenus: the parent item's rectangle, so the menu can open beside it. */
  anchor?: DOMRect;
}

/** A keyboard-friendly floating menu: arrows, Home/End, Enter, Esc, → opens a submenu, ← closes it. */
export function FloatingMenu({ at, items, onClose, label, autoFocus = true, anchor }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ item: MenuItem; rect: DOMRect } | null>(null);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  // keep inside the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor ? anchor.right + 2 : at.x;
    let top = anchor ? anchor.top - 6 : at.y;
    if (left + r.width > window.innerWidth - 8)
      left = anchor
        ? Math.max(8, anchor.left - r.width - 2)
        : Math.max(8, window.innerWidth - r.width - 8);
    if (top + r.height > window.innerHeight - 8)
      top = Math.max(8, window.innerHeight - r.height - 8);
    setPos({ left, top });
  }, [at.x, at.y, anchor, items.length]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => {
    if (anchor) return; // submenus do not own outside-click handling
    const down = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (ref.current?.contains(e.target) || (e.target as HTMLElement).closest?.('.lp-menu'))
        return;
      onClose();
    };
    const blur = () => onClose();
    document.addEventListener('mousedown', down, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('mousedown', down, true);
      window.removeEventListener('blur', blur);
    };
  }, [onClose, anchor]);

  const choose = (it: MenuItem, el?: HTMLElement | null) => {
    if (it.disabled) return;
    if (it.children?.length) {
      if (el) setSub({ item: it, rect: el.getBoundingClientRect() });
      return;
    }
    onClose();
    it.onSelect?.();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const move = (d: 1 | -1) => {
      if (!enabled.length) return;
      const cur = enabled.indexOf(active);
      setActive(enabled[(cur + d + enabled.length) % enabled.length]!);
      setSub(null);
    };
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(enabled[0] ?? -1);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(enabled.at(-1) ?? -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (sub) setSub(null);
      else onClose();
    } else if (e.key === 'ArrowRight' && items[active]?.children) {
      e.preventDefault();
      const el = ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]')[active];
      choose(items[active]!, el);
    } else if (e.key === 'ArrowLeft' && anchor) {
      e.preventDefault();
      onClose();
    } else if ((e.key === 'Enter' || e.key === ' ') && items[active]) {
      e.preventDefault();
      const el = ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]')[active];
      choose(items[active]!, el);
    }
  };

  let lastSection: string | undefined;
  const rows: ReactNode[] = [];
  items.forEach((it, i) => {
    if (it.section && it.section !== lastSection) {
      lastSection = it.section;
      rows.push(
        <div key={`s-${it.section}`} className="lp-menu-section" role="presentation">
          {it.section}
        </div>,
      );
    }
    rows.push(
      <div
        key={it.id}
        role="menuitem"
        tabIndex={-1}
        aria-disabled={it.disabled || undefined}
        aria-haspopup={it.children ? 'menu' : undefined}
        aria-expanded={it.children ? sub?.item.id === it.id : undefined}
        aria-checked={it.checked}
        className={`lp-menu-item${active === i ? ' active' : ''}${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}`}
        onMouseEnter={(e) => {
          setActive(i);
          if (it.children) choose(it, e.currentTarget);
          else setSub(null);
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => choose(it, e.currentTarget)}
      >
        {it.glyph !== undefined && (
          <span className="lp-menu-glyph" aria-hidden="true">
            {it.glyph}
          </span>
        )}
        <span className="lp-menu-label">{it.label}</span>
        {it.checked && <span aria-hidden="true">✓</span>}
        {it.shortcut && <span className="lp-menu-shortcut">{it.shortcut}</span>}
        {it.children && (
          <span className="lp-menu-shortcut" aria-hidden="true">
            ▸
          </span>
        )}
      </div>,
    );
  });

  return createPortal(
    <>
      <div
        ref={ref}
        className="lp-menu"
        role="menu"
        aria-label={label}
        tabIndex={0}
        style={{ left: pos.left, top: pos.top }}
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
      >
        {rows}
      </div>
      {sub && (
        <FloatingMenu
          at={at}
          items={sub.item.children!}
          onClose={onClose}
          label={sub.item.label}
          anchor={sub.rect}
        />
      )}
    </>,
    document.body,
  );
}
