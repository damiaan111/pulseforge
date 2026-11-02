// The MilkDrop library in the Presets panel: search and a picture of each. A card behaves as every
// visual does (src/project/layer-picker.ts): marked when in use, off when clicked again, and clicking
// another swaps it. There are about 1,750 presets, so only as many cards as asked for exist at once.

import { useEffect, useMemo, useRef, useState } from 'react';

import { newId } from '../../project/ids.ts';
import { milkdropLayer, pickMilkdrop } from '../../project/layer-picker.ts';
import { milkdropIndex, presetCardImage, type MilkdropIndex } from '../milkdrop.ts';
import { useModules } from '../modules.ts';
import { useStudio } from '../store.ts';

const PAGE = 40;

function Card(props: { readonly name: string; readonly file: string }): React.JSX.Element {
  const { name, file } = props;
  const run = useStudio((s) => s.run);
  const select = useStudio((s) => s.select);
  const notify = useStudio((s) => s.notify);
  const selectedLayerId = useStudio((s) => s.selectedLayerId);
  const document = useStudio((s) => s.document);
  const { manifests } = useModules();
  const [image, setImage] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  // Made only once the card is on screen: nobody scrolls through 1,750 of them.
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void presetCardImage(name, file).then(setImage);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [name, file]);

  const inUse = milkdropLayer(document, name) !== undefined;
  const pick = (stack: boolean) => {
    const result = pickMilkdrop(document, selectedLayerId, name, (id) => manifests.get(id)?.kind, stack, newId);
    run(result.command);
    select(result.select);
    if (result.note !== null) notify({ text: result.note, kind: 'warn' });
  };

  return (
    <li className={`preset-card${inUse ? ' in-use' : ''}`} data-milkdrop={name} data-in-use={inUse}>
      <button
        ref={ref}
        type="button"
        className="preset-thumb"
        data-action="apply-milkdrop"
        title={inUse ? 'In use. Click to remove it' : 'Click to use it; Shift+click adds it on top'}
        onClick={(event) => pick(event.shiftKey)}
      >
        {image === null ? <span className="strip loading" /> : <img src={image} alt="" />}
      </button>
      <div className="preset-name" title={name}>
        {inUse ? <span className="preset-check" aria-label="In use">✓ </span> : null}
        {name}
      </div>
    </li>
  );
}

export function MilkdropPanel(props: { readonly text: string }): React.JSX.Element {
  const { text } = props;
  const [index, setIndex] = useState<MilkdropIndex | null | undefined>(undefined);
  const [shown, setShown] = useState(PAGE);
  const setSettingsOpen = useStudio((s) => s.setSettingsOpen);

  useEffect(() => {
    void milkdropIndex().then(setIndex);
  }, []);
  useEffect(() => setShown(PAGE), [text]);

  const found = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return (index?.presets ?? []).filter((preset) => words.every((word) => preset.name.toLowerCase().includes(word)));
  }, [index, text]);

  if (index === undefined) return <p className="dim">Reading the library…</p>;
  if (index === null) {
    return (
      <p className="empty" data-testid="milkdrop-missing">
        The MilkDrop library is not installed. <button type="button" className="link" onClick={() => setSettingsOpen(true)}>Add it in Settings → Components</button>
      </p>
    );
  }
  return (
    <>
      <p className="dim note" data-testid="milkdrop-count">{found.length} of {index.presets.length} presets, by the MilkDrop community.</p>
      <ul className="preset-grid" data-testid="milkdrop-grid">
        {found.slice(0, shown).map((preset) => <Card key={preset.name} name={preset.name} file={preset.file} />)}
      </ul>
      {found.length > shown ? <button type="button" className="wide" data-action="milkdrop-more" onClick={() => setShown(shown + PAGE)}>Show more</button> : null}
    </>
  );
}
