// The studio's side of the MilkDrop library: what is installed, loading a preset's script, and the
// pictures on its cards. Scripts load by `<script>`, from vendor/ through the main process's file
// URL, so the page's content security policy stays as strict as it was.

import { loadButterchurn, MilkdropRenderer, presetLoaded, presetStill } from '../milkdrop/renderer.ts';

export interface MilkdropIndex {
  readonly baseUrl: string;
  readonly presets: readonly { readonly name: string; readonly file: string }[];
}

let index: Promise<MilkdropIndex | null> | undefined;

export function milkdropIndex(): Promise<MilkdropIndex | null> {
  index ??= window.pulseforge.milkdropIndex();
  return index;
}

/** After installing them from Settings: read the list again. */
export function forgetMilkdropIndex(): void {
  index = undefined;
}

const loading = new Map<string, Promise<boolean>>();

/** Resolves true once the preset can be rendered; false when it is not installed. */
export function loadPreset(name: string): Promise<boolean> {
  if (presetLoaded(name)) return Promise.resolve(true);
  const pending = loading.get(name);
  if (pending !== undefined) return pending;
  const started = (async () => {
    const found = await milkdropIndex();
    const entry = found?.presets.find((preset) => preset.name === name);
    if (found == null || entry === undefined) return false;
    await loadButterchurn();
    return new Promise<boolean>((resolve) => {
      const script = document.createElement('script');
      script.src = `${found.baseUrl}/${entry.file}`;
      script.onload = () => resolve(presetLoaded(name));
      script.onerror = () => resolve(false);
      document.head.append(script);
    });
  })();
  loading.set(name, started);
  return started;
}

const CARD_WIDTH = 240;
const CARD_HEIGHT = 135;
/** Long enough for a preset to build a picture; a card takes about half a second. */
const CARD_FRAMES = 45;

const stills = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();
let host: MilkdropRenderer | undefined;

async function makeStill(name: string, key: string): Promise<string | null> {
  const stored = await window.pulseforge.presetThumbnail(key);
  if (stored !== null) return URL.createObjectURL(new Blob([stored as unknown as BlobPart], { type: 'image/png' }));
  if (!(await loadPreset(name))) return null;
  host ??= new MilkdropRenderer();
  // Between paints, so scrolling the list never stutters the preview for long.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const canvas = presetStill(host, name, CARD_WIDTH, CARD_HEIGHT, CARD_FRAMES);
  if (canvas === null) throw new Error('the preset drew nothing');
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob === null) throw new Error('the picture could not be encoded');
  await window.pulseforge.storePresetThumbnail(key, new Uint8Array(await blob.arrayBuffer()));
  return URL.createObjectURL(blob);
}

/** The card's picture: made once, one at a time, and kept on disk with the other thumbnails. */
export function presetCardImage(name: string, file: string): Promise<string | null> {
  const known = stills.get(name);
  if (known !== undefined) return known;
  // The store takes 32 hex digits; the file name is 16, a hash of the preset's name.
  // A card without a picture still works, but why it has none goes to the log (CLAUDE.md #4).
  const next = queue.then(() => makeStill(name, file.replace('.js', '').padEnd(32, '0'))).catch((error: unknown) => {
    console.warn(`[milkdrop] no card picture for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  queue = next;
  stills.set(name, next);
  return next;
}
