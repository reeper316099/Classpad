/**
 * The note editor's core runs in Go, compiled to WebAssembly (cmd/editorwasm). It owns the block document,
 * selection, undo history and every editing command; this file loads it and gives it a typed API.
 */

export type Attrs = Record<string, unknown>;
export interface TextOp {
  insert: string;
  attributes?: Attrs;
}
export type Path = number[];
export interface Position {
  path: Path;
  offset: number;
}
export interface Selection {
  start: Position;
  end: Position;
}
export interface TreeNode {
  id: string;
  children?: TreeNode[];
}
export interface BlockData {
  type: string;
  data?: Attrs;
  delta?: TextOp[];
  number?: number;
}
export interface View {
  tree?: TreeNode[];
  blocks: Record<string, BlockData>;
  selection: Selection;
  marks?: Attrs;
  canUndo: boolean;
  canRedo: boolean;
  full?: boolean;
}
export interface Result {
  view?: View;
  changed: boolean;
  text?: string;
  plain?: string;
  error?: string;
}

export type Command =
  | { name: 'select'; selection: Selection }
  | { name: 'insertText'; text: string }
  | { name: 'syncText'; path: Path; text: string; caret: number }
  | { name: 'toggleMark'; mark: string }
  | { name: 'setLink'; href: string }
  | { name: 'insertFormula'; text: string }
  | { name: 'setFormula'; path: Path; offset: number; text: string }
  | { name: 'turnInto'; type: string; attrs?: Attrs }
  | { name: 'insertBlock'; type: string; attrs?: Attrs; text?: string }
  | { name: 'slash'; type: string; attrs?: Attrs; queryLen: number }
  | { name: 'setAttrs'; path: Path; attrs: Attrs }
  | { name: 'move'; id: string; target: string; where: 'before' | 'after' | 'inside' }
  | { name: 'duplicate' | 'deleteBlock'; id: string }
  | { name: 'paste'; markdown: string; plain?: boolean }
  | { name: 'load'; markdown: string }
  | {
      name:
        | 'insertNewline'
        | 'insertSoftBreak'
        | 'deleteBackward'
        | 'deleteForward'
        | 'deleteSelection'
        | 'indent'
        | 'outdent'
        | 'toggleTodo'
        | 'moveUp'
        | 'moveDown'
        | 'selectAll'
        | 'undo'
        | 'redo'
        | 'copy'
        | 'cut'
        | 'view';
    };

interface Bridge {
  create(md: string): number;
  exec(handle: number, json: string): string;
  markdown(handle: number): string;
  destroy(handle: number): void;
}

declare global {
  interface Window {
    Go?: new () => {
      importObject: WebAssembly.Imports;
      run(i: WebAssembly.Instance): Promise<void>;
    };
    classpadEditor?: Bridge;
    classpadEditorReady?: () => void;
  }
}

let loading: Promise<Bridge> | null = null;

const base = () => `${import.meta.env.BASE_URL ?? '/'}editor/`;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

/** Load the Go core once per page. */
export function loadCore(): Promise<Bridge> {
  if (window.classpadEditor) return Promise.resolve(window.classpadEditor);
  loading ??= (async () => {
    if (!window.Go) await loadScript(`${base()}wasm_exec.js`);
    const go = new window.Go!();
    const ready = new Promise<void>((r) => (window.classpadEditorReady = r));
    const res = await fetch(`${base()}editor.wasm`);
    if (!res.ok) throw new Error(`editor core missing (${res.status})`);
    const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), go.importObject);
    void go.run(instance);
    await ready;
    return window.classpadEditor!;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** One open note in the Go core. */
export class EditorCore {
  private constructor(
    private bridge: Bridge,
    private handle: number,
  ) {}

  static async open(markdown: string): Promise<EditorCore> {
    const b = await loadCore();
    return new EditorCore(b, b.create(markdown));
  }

  exec(cmd: Command): Result {
    const r = JSON.parse(this.bridge.exec(this.handle, JSON.stringify(cmd))) as Result;
    if (r.error) console.warn('editor:', r.error);
    return r;
  }

  markdown(): string {
    return this.bridge.markdown(this.handle);
  }

  close(): void {
    this.bridge.destroy(this.handle);
  }
}
