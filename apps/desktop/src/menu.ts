import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';

export type MenuAction =
  | 'new-assignment'
  | 'new-note'
  | 'new-task'
  | 'new-class'
  | 'new-semester'
  | 'quick-open'
  | 'palette'
  | 'settings'
  | 'import'
  | 'help'
  | 'go-dashboard'
  | 'go-classes'
  | 'go-assignments'
  | 'go-notes'
  | 'go-planner'
  | 'go-study'
  | 'go-grades'
  | 'go-gpa';

export interface MenuHooks {
  win: () => BrowserWindow | null;
  exportPdf: () => void;
  openDataFolder: () => void;
  appName: string;
}

export function buildMenu(h: MenuHooks): Menu {
  const send = (a: MenuAction) => () => h.win()?.webContents.send('classpad:menu', a);
  const mac = process.platform === 'darwin';
  const nav = (label: string, a: MenuAction, n: number): MenuItemConstructorOptions => ({
    label,
    accelerator: `CmdOrCtrl+${n}`,
    click: send(a),
  });
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: h.appName,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Assignment',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: send('new-assignment'),
        },
        // the app handles N, T, Ctrl/Cmd+K and Ctrl/Cmd+P itself; these entries only show the shortcut
        { label: 'New Note', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-note') },
        { label: 'New Task', accelerator: 'CmdOrCtrl+Shift+T', click: send('new-task') },
        { label: 'New Class…', click: send('new-class') },
        { label: 'New Semester…', click: send('new-semester') },
        { type: 'separator' },
        {
          label: 'Open Note…',
          accelerator: 'CmdOrCtrl+P',
          registerAccelerator: false,
          click: send('quick-open'),
        },
        {
          label: 'Command Palette…',
          accelerator: 'CmdOrCtrl+K',
          registerAccelerator: false,
          click: send('palette'),
        },
        { type: 'separator' },
        { label: 'Import & Export…', click: send('import') },
        { label: 'Save Grade Report as PDF…', click: h.exportPdf },
        ...(mac
          ? []
          : [
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'Ctrl+,', click: send('settings') },
              { role: 'quit' as const },
            ]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        nav('Dashboard', 'go-dashboard', 1),
        nav('Classes', 'go-classes', 2),
        nav('Assignments', 'go-assignments', 3),
        nav('Notes', 'go-notes', 4),
        nav('Planner', 'go-planner', 5),
        nav('Study', 'go-study', 6),
        nav('Grades', 'go-grades', 7),
        nav('GPA', 'go-gpa', 8),
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : [
              { type: 'separator' as const },
              { role: 'reload' as const },
              { role: 'toggleDevTools' as const },
            ]),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(mac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          accelerator: 'Shift+/',
          registerAccelerator: false,
          click: send('help'),
        },
        { label: 'Show Data Folder', click: h.openDataFolder },
        { label: 'Your data stays on this computer', enabled: false },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  void shell;
  return Menu.buildFromTemplate(template);
}
