import { startCompletion } from '@codemirror/autocomplete';
import { Facet, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { parseLine } from './blocks.js';
import { liveEnabled } from './live.js';
import { blockAt, reorderBlock, type Block } from './model.js';
import { renumberOrdered } from './model.js';

export interface HandleHooks {
  /** The grip was clicked: show the block menu at the point, for the block containing `pos`. */
  openBlockMenu(at: { x: number; y: number }, pos: number): void;
  /** Right-click inside the note. */
  openContextMenu(at: { x: number; y: number }, pos: number): void;
}
export const handleHooks = Facet.define<HandleHooks, HandleHooks>({
  combine: (v) => v[0] ?? { openBlockMenu: () => undefined, openContextMenu: () => undefined },
});

/** Add an empty block under the block at `pos` and open the "/" menu in it, like Notion's + button. */
export function insertBelow(view: EditorView, pos: number) {
  const b = blockAt(view.state, pos);
  if (!b) return;
  let insert = '\n\n/';
  let caret = b.to + 3;
  if (b.isList) {
    const first = view.state.doc.lineAt(b.from).text;
    const p = parseLine(first);
    const marker =
      p.kind === 'number'
        ? '1. '
        : p.kind === 'todo' || p.kind === 'todo-done'
          ? '- [ ] '
          : p.marker || '- ';
    insert = `\n${p.indent}${marker}/`;
    caret = b.to + insert.length;
  }
  view.dispatch({
    changes: { from: b.to, insert },
    selection: { anchor: caret },
    userEvent: 'input.block',
    scrollIntoView: true,
  });
  view.focus();
  startCompletion(view);
}

class HandlePlugin {
  el: HTMLDivElement;
  plus: HTMLButtonElement;
  grip: HTMLButtonElement;
  drop: HTMLDivElement;
  block: Block | null = null;
  hideTimer: ReturnType<typeof setTimeout> | undefined;
  drag: { startY: number; active: boolean; block: Block; index: number } | null = null;

  constructor(readonly view: EditorView) {
    this.el = document.createElement('div');
    this.el.className = 'lp-handle';
    this.plus = document.createElement('button');
    this.plus.type = 'button';
    this.plus.className = 'lp-plus';
    this.plus.textContent = '+';
    this.plus.tabIndex = -1;
    this.plus.setAttribute('aria-label', 'Add a block below');
    this.plus.title = 'Click to add a block below';
    this.grip = document.createElement('button');
    this.grip.type = 'button';
    this.grip.className = 'lp-grip';
    this.grip.textContent = '⋮⋮';
    this.grip.tabIndex = -1;
    this.grip.setAttribute('aria-label', 'Drag to move this block, click for options');
    this.grip.title = 'Drag to move · click for options';
    this.el.append(this.plus, this.grip);
    this.drop = document.createElement('div');
    this.drop.className = 'lp-drop';
    view.scrollDOM.append(this.el, this.drop);
    this.hide();

    view.dom.addEventListener('mousemove', this.onMove);
    view.dom.addEventListener('mouseleave', this.onLeave);
    this.el.addEventListener('mouseenter', () => clearTimeout(this.hideTimer));
    this.el.addEventListener('mouseleave', this.onLeave);
    view.dom.addEventListener('contextmenu', this.onContext);
    this.plus.addEventListener('mousedown', (e) => e.preventDefault());
    this.plus.addEventListener('click', () => this.block && insertBelow(view, this.block.from));
    this.grip.addEventListener('pointerdown', this.onGripDown);
  }

  private enabled() {
    return this.view.state.facet(liveEnabled);
  }

  hide = () => {
    this.el.style.display = 'none';
    this.block = null;
  };

  onLeave = () => {
    if (this.drag?.active) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(this.hide, 250);
  };

  onMove = (e: MouseEvent) => {
    if (this.drag?.active || !this.enabled()) return;
    if (e.target instanceof Element && e.target.closest('.lp-handle')) return;
    const v = this.view;
    const rect = v.contentDOM.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX, rect.left + 8), rect.right - 8);
    const pos = v.posAtCoords({ x, y: e.clientY }, false);
    if (pos == null) return;
    const b = blockAt(v.state, pos);
    if (!b) {
      this.onLeave();
      return;
    }
    clearTimeout(this.hideTimer);
    this.show(b);
  };

  show(b: Block) {
    const v = this.view;
    if (this.block && this.block.from === b.from && this.block.to === b.to) return;
    this.block = b;
    const c = v.coordsAtPos(b.from);
    if (!c) return this.hide();
    const sc = v.scrollDOM.getBoundingClientRect();
    const content = v.contentDOM.getBoundingClientRect();
    const top = c.top - sc.top + v.scrollDOM.scrollTop;
    const lh = Math.max(24, c.bottom - c.top);
    this.el.style.display = 'flex';
    this.el.style.top = `${top + (lh - 24) / 2}px`;
    this.el.style.left = `${Math.max(0, content.left - sc.left + v.scrollDOM.scrollLeft + parseFloat(getComputedStyle(v.contentDOM).paddingLeft) - 54)}px`;
  }

  onContext = (e: MouseEvent) => {
    if (!this.enabled()) return;
    if (e.target instanceof Element && e.target.closest('.lp-handle')) return;
    e.preventDefault();
    const pos =
      this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false) ??
      this.view.state.selection.main.head;
    this.view.state.facet(handleHooks).openContextMenu({ x: e.clientX, y: e.clientY }, pos);
  };

  // ---- drag to reorder ----
  onGripDown = (e: PointerEvent) => {
    if (!this.block || e.button !== 0) return;
    e.preventDefault();
    const block = this.block;
    this.drag = { startY: e.clientY, active: false, block, index: block.index };
    this.grip.setPointerCapture(e.pointerId);
    this.grip.addEventListener('pointermove', this.onGripMove);
    this.grip.addEventListener('pointerup', this.onGripUp);
    this.grip.addEventListener('pointercancel', this.onGripCancel);
  };

  private dropIndex(y: number): number {
    const { block } = this.drag!;
    const v = this.view;
    const sibs = block.siblings;
    for (let i = 0; i < sibs.length; i++) {
      const c = v.coordsAtPos(sibs[i]!.from);
      const e = v.coordsAtPos(sibs[i]!.to);
      if (!c || !e) continue;
      if (y < (c.top + e.bottom) / 2) return i;
    }
    return sibs.length;
  }

  private showDrop(index: number) {
    const v = this.view;
    const { block } = this.drag!;
    const sibs = block.siblings;
    const sc = v.scrollDOM.getBoundingClientRect();
    const edge =
      index < sibs.length
        ? v.coordsAtPos(sibs[index]!.from)?.top
        : v.coordsAtPos(sibs[sibs.length - 1]!.to)?.bottom;
    if (edge == null) return;
    const content = v.contentDOM.getBoundingClientRect();
    this.drop.style.display = 'block';
    this.drop.style.top = `${edge - sc.top + v.scrollDOM.scrollTop - 1}px`;
    this.drop.style.left = `${content.left - sc.left + v.scrollDOM.scrollLeft + parseFloat(getComputedStyle(v.contentDOM).paddingLeft)}px`;
    this.drop.style.width = `${content.width - parseFloat(getComputedStyle(v.contentDOM).paddingLeft) - parseFloat(getComputedStyle(v.contentDOM).paddingRight)}px`;
  }

  onGripMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (!d.active && Math.abs(e.clientY - d.startY) > 5) {
      d.active = true;
      this.el.classList.add('dragging');
    }
    if (d.active) {
      d.index = this.dropIndex(e.clientY);
      this.showDrop(d.index);
    }
  };

  finishDrag() {
    this.grip.removeEventListener('pointermove', this.onGripMove);
    this.grip.removeEventListener('pointerup', this.onGripUp);
    this.grip.removeEventListener('pointercancel', this.onGripCancel);
    this.drop.style.display = 'none';
    this.el.classList.remove('dragging');
    this.drag = null;
  }

  onGripCancel = () => this.finishDrag();

  onGripUp = (e: PointerEvent) => {
    const d = this.drag;
    this.grip.releasePointerCapture?.(e.pointerId);
    this.finishDrag();
    if (!d) return;
    const v = this.view;
    if (!d.active) {
      const r = this.grip.getBoundingClientRect();
      v.state.facet(handleHooks).openBlockMenu({ x: r.left, y: r.bottom + 4 }, d.block.from);
      return;
    }
    const edit = reorderBlock(v.state, d.block, d.index);
    if (edit) {
      v.dispatch({
        changes: edit.changes,
        selection: { anchor: edit.select.anchor },
        userEvent: 'input.block',
        scrollIntoView: true,
      });
      if (d.block.kind === 'number') {
        const fix = renumberOrdered(v.state, v.state.selection.main.head);
        if (fix.length) v.dispatch({ changes: fix, userEvent: 'input.block' });
      }
    }
    this.hide();
  };

  update(u: ViewUpdate) {
    if (u.docChanged) this.hide();
    if (!this.enabled()) this.hide();
  }

  destroy() {
    clearTimeout(this.hideTimer);
    this.view.dom.removeEventListener('mousemove', this.onMove);
    this.view.dom.removeEventListener('mouseleave', this.onLeave);
    this.view.dom.removeEventListener('contextmenu', this.onContext);
    this.el.remove();
    this.drop.remove();
  }
}

export const blockHandles = (): Extension => ViewPlugin.fromClass(HandlePlugin);
