// What the Mac's menu bar asks for (shell/mac-menu.ts), done the way the keyboard and the top bar do it.

import type { MenuCommand } from '../shell/ipc.ts';
import { dialogOpen } from './shortcuts.ts';
import { useStudio } from './store.ts';

function typingInField(): boolean {
  const target = document.activeElement as HTMLElement | null;
  return target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

export function runMenuCommand(command: MenuCommand): void {
  const state = useStudio.getState();
  switch (command) {
    case 'undo':
    case 'redo':
      // In a text field the menu's Undo is the field's, as the key would be; over an open dialog the
      // project stays as it is, as the keyboard leaves it (ui/components/App.tsx).
      if (typingInField()) document.execCommand(command);
      else if (!dialogOpen()) {
        if (command === 'undo') state.undo();
        else state.redo();
      }
      return;
    case 'new':
      state.newProject();
      return;
    case 'open':
      void state.openProject();
      return;
    case 'save':
      void state.save();
      return;
    case 'save-as':
      void state.saveAs();
      return;
    case 'export':
      state.setExportOpen(true);
      return;
    case 'settings':
      state.setSettingsOpen(true);
      return;
  }
}
