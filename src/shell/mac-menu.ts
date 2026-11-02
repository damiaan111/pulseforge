// The Mac's menu bar. Windows shows none (the studio's top bar is the menu there); a Mac always has
// one, and people expect File, Edit and Window in it with the usual keys.
//
// Every command goes to the page as a menu command (IPC.menuCommand) and runs exactly what the
// keyboard and the top bar run (ui/menu-commands.ts). A menu item with a key takes that key before the
// page sees it, so the menu has to do the whole job, text fields included: Undo in a field undoes the
// typing, and the project's undo everywhere else.

import { BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

import { IPC, type MenuCommand } from './ipc.ts';

function send(command: MenuCommand): () => void {
  return () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    window?.webContents.send(IPC.menuCommand, command);
  };
}

export function macMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: send('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'Cmd+N', click: send('new') },
        { label: 'Open…', accelerator: 'Cmd+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'Cmd+S', click: send('save') },
        { label: 'Save As…', accelerator: 'Shift+Cmd+S', click: send('save-as') },
        { type: 'separator' },
        { label: 'Export Video…', accelerator: 'Cmd+E', click: send('export') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'Cmd+Z', click: send('undo') },
        { label: 'Redo', accelerator: 'Shift+Cmd+Z', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
