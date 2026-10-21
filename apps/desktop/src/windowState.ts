import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface State extends Partial<Rectangle> {
  maximized?: boolean;
}
const DEFAULT = { width: 1280, height: 820 };

/** Remembers window size/position between launches and never restores a window off-screen. */
export class WindowState {
  private timer?: ReturnType<typeof setTimeout>;
  private state: State = {};
  constructor(private file: string) {}

  async load(): Promise<State & { width: number; height: number }> {
    try {
      this.state = JSON.parse(await fs.readFile(this.file, 'utf8')) as State;
    } catch {
      this.state = {};
    }
    const s = this.state;
    const ok =
      typeof s.x === 'number' &&
      typeof s.y === 'number' &&
      typeof s.width === 'number' &&
      typeof s.height === 'number' &&
      screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        // at least a 100px square of the window must be visible on some display
        return (
          s.x! + s.width! - 100 > a.x &&
          s.x! + 100 < a.x + a.width &&
          s.y! + 100 < a.y + a.height &&
          s.y! >= a.y - 20
        );
      });
    if (!ok) return { ...DEFAULT, maximized: s.maximized };
    return {
      x: s.x,
      y: s.y,
      width: Math.max(800, s.width!),
      height: Math.max(560, s.height!),
      maximized: s.maximized,
    };
  }

  track(win: BrowserWindow): void {
    const save = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.write(win), 400);
    };
    win.on('resize', save);
    win.on('move', save);
    win.on('maximize', save);
    win.on('unmaximize', save);
    win.on('close', () => {
      clearTimeout(this.timer);
      void this.write(win);
    });
  }

  private async write(win: BrowserWindow): Promise<void> {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized
      ? this.state.width
        ? (this.state as Rectangle)
        : win.getNormalBounds()
      : win.getBounds();
    this.state = { ...b, maximized };
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.state));
    } catch {
      /* not critical */
    }
  }
}
