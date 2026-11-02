// Renderer entry point for the studio.
//
// The page is mounted here and nowhere else; everything below is React. The shell contract the
// earlier plain-DOM view established still holds and must keep holding: the renderer never
// touches the filesystem, every mutation goes through the command stack, and every problem the
// loader found ends up on screen rather than in a console.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './components/App.tsx';
import { history, useStudio } from './store.ts';

const container = document.getElementById('app');
if (container === null) throw new Error('The renderer page has no #app element');

container.className = '';
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

async function start(): Promise<void> {
  try {
    const initial = await window.pulseforge.initialProject();
    if (initial !== null) useStudio.getState().adopt(initial);
  } catch (error) {
    useStudio.getState().notify({
      text: `Starting up failed. ${error instanceof Error ? error.message : String(error)}`,
      kind: 'bad',
    });
  } finally {
    // Startup is async, so "the page has painted" is not "the app has settled". Anything
    // driving the window from outside — the launch smoke check, UI tests later — waits on this.
    document.body.dataset['pulseforgeReady'] = 'true';
  }
}

void start();
window.pulseforge.onProjectOpenRequest((file) => useStudio.getState().openRequested(file));

// Closing the window with unsaved work asks first. The renderer only says "there is something to
// lose"; the main process shows the question (`will-prevent-unload`), since a page cannot.
window.addEventListener('beforeunload', (event) => {
  if (history.dirty) event.preventDefault();
});
