// The canvas preview (ui-spec §2): the live render, the aspect switcher, quality, and the
// dropped-frame indicator.
//
// The preview host owns the loop; this component only creates it, feeds it the document, and
// shows what it reports. Nothing here runs per frame.

import { useEffect, useRef, useState } from 'react';

import { setCanvas } from '../../project/commands.ts';
import { ASPECT_BUCKETS, aspectBucket, type AspectBucket } from '../../project/document.ts';
import { PreviewHost } from '../preview/host.ts';
import { setThumbnailHost } from '../preset-thumbnails.ts';
import { shaderModuleDefinition } from '../../engine/modules/shader-module.ts';
import { useStudio } from '../store.ts';
import { TapOverlay } from './TapOverlay.tsx';

/** Canvas sizes for the aspect switcher, all about 2 megapixels so switching is like for like. */
const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1440, height: 1440 },
  '4:5': { width: 1280, height: 1600 },
};

/**
 * The preview host, reachable from the transport and the timeline without threading a ref
 * through React. There is exactly one preview, so a module-level handle is honest; it is set
 * when the pane mounts and cleared when it unmounts, and every method no-ops before then.
 */
let activeHost: PreviewHost | null = null;

export const previewControls = {
  play: () => activeHost?.play(),
  pause: () => activeHost?.pause(),
  stop: () => activeHost?.stop(),
  seek: (timelineSeconds: number) => activeHost?.seek(timelineSeconds),
  transport: () => activeHost?.transport ?? 'stopped',
  /** The playhead now, unsnapped: what a lyric tap measures against. */
  positionNow: () => activeHost?.positionNow() ?? 0,
  setRate: (rate: number) => activeHost?.setRate(rate),
  playbackRate: () => activeHost?.playbackRate ?? 1,
};

export function CanvasPane(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const hostRef = useRef<PreviewHost | null>(null);

  const document = useStudio((s) => s.document);
  const analysis = useStudio((s) => s.analysis);
  const audio = useStudio((s) => s.audio);
  const previewScale = useStudio((s) => s.previewScale);
  const images = useStudio((s) => s.images);
  const fonts = useStudio((s) => s.fonts);
  const defaultFont = useStudio((s) => s.defaultFont);
  const videos = useStudio((s) => s.videos);
  const userModules = useStudio((s) => s.userModules);
  const setPreviewScale = useStudio((s) => s.setPreviewScale);
  const stats = useStudio((s) => s.stats);
  const editTarget = useStudio((s) => s.editTarget);
  const setEditTarget = useStudio((s) => s.setEditTarget);
  const run = useStudio((s) => s.run);
  const reportPreview = useStudio((s) => s.reportPreview);
  const reportModulation = useStudio((s) => s.reportModulation);
  const notify = useStudio((s) => s.notify);

  const [error, setError] = useState<string | null>(null);
  // The preview's error overlay; the host clears it with null when a later document renders.
  const [notes, setNotes] = useState<readonly string[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const element = audioRef.current;
    if (canvas === null || element === null) return;
    const host = new PreviewHost(canvas, element, {
      onStatus: reportPreview,
      onModulation: reportModulation,
      onError: setError,
      onNotes: setNotes,
    });
    hostRef.current = host;
    // Preset thumbnails draw on this host's context (S8), so they wait for it.
    setThumbnailHost(host);
    activeHost = host;
    host.start();
    return () => {
      setThumbnailHost(null);
      host.dispose();
      hostRef.current = null;
      if (activeHost === host) activeHost = null;
    };
  }, [reportPreview, reportModulation]);

  useEffect(() => {
    hostRef.current?.setDocument(document, analysis);
  }, [document, analysis]);

  useEffect(() => {
    hostRef.current?.setScale(previewScale);
  }, [previewScale]);

  useEffect(() => {
    hostRef.current?.setImages(images);
  }, [images]);

  useEffect(() => {
    hostRef.current?.setFonts(defaultFont, fonts);
  }, [defaultFont, fonts]);

  useEffect(() => {
    hostRef.current?.setModules(userModules.map(shaderModuleDefinition));
  }, [userModules]);

  useEffect(() => {
    hostRef.current?.setVideos([...videos.entries()].map(([hash, proxy]) => ({ hash, frameCount: proxy.frameCount })));
  }, [videos]);

  const canvasAspect = aspectBucket(document.canvas.width, document.canvas.height);
  const effective = {
    width: Math.round(document.canvas.width * previewScale),
    height: Math.round(document.canvas.height * previewScale),
  };
  const dropped = stats?.droppedRecent ?? 0;

  function switchAspect(bucket: AspectBucket): void {
    const size = ASPECT_SIZES[bucket];
    if (size === undefined) return;
    run(setCanvas(size));
    // Editing follows the aspect you switched to, which is the whole point of D44 — and the
    // badge below has to make that unmissable.
    setEditTarget(bucket);
  }

  return (
    <section className="canvas-pane">
      <div className="canvas-bar">
        <span className="badge">{document.canvas.width}×{document.canvas.height}</span>
        <span className="badge">{canvasAspect}</span>
        <div className="aspects">
          {ASPECT_BUCKETS.filter((b) => b !== 'custom').map((bucket) => (
            <button
              key={bucket}
              type="button"
              className={bucket === canvasAspect ? 'active' : ''}
              onClick={() => switchAspect(bucket)}
            >
              {bucket}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="quality">
          Quality
          <select value={String(previewScale)} onChange={(e) => setPreviewScale(Number(e.target.value))}>
            <option value="0.25">25%</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
          </select>
        </label>
        <span className="badge dim">{effective.width}×{effective.height}</span>
      </div>

      <div className={`canvas-stage${editTarget === 'base' ? '' : ' overriding'}`}>
        <canvas ref={canvasRef} className="preview" />
        {error === null ? null : <div className="canvas-error">{error}</div>}
        {dropped > 0 && (
          <div className="dropped" title="Export quality is unaffected — export never uses this clock.">
            {dropped} dropped
          </div>
        )}
        <TapOverlay />
        {editTarget !== 'base' && (
          <button type="button" className="override-banner" onClick={() => setEditTarget('base')}>
            Editing the {editTarget} override — click to edit the base instead
          </button>
        )}
      </div>

      {notes.length > 0 && (
        <button type="button" className="canvas-notes" onClick={() => notify({ text: notes.join('\n'), kind: 'warn' })}>
          {notes.length} engine note{notes.length === 1 ? '' : 's'} — click to read
        </button>
      )}

      {/* Playback only. Analysis comes from the main process so the preview reacts to exactly
          the numbers the export will (shell/ipc.ts). */}
      {/* No src attribute at all until there is audio: an empty one makes Chromium re-request
          the page itself. */}
      {audio === null
        ? <audio ref={audioRef} preload="auto" />
        : <audio ref={audioRef} src={audio.url} preload="auto" />}
    </section>
  );
}
