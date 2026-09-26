// "Paste a Shadertoy" (PROJECT.md S2: "Shadertoy-compatible, with audio uniforms and live compile
// errors"). Paste a shader's Image code from shadertoy.com, see as you type whether it compiles —
// with the error on your own line — and add it: it is saved as modules/<name>.glsl (the same thing
// as dropping the file in by hand) and put on the project as a layer.
//
// The check compiles on a small WebGL2 context of the dialog's own, with exactly the prelude and
// wrapper a render uses (shader-module.ts), so "compiles here" means "renders there". Multi-pass
// shaders (Buffer A…) and image channels are not supported; iChannel0 is the audio.

import { useEffect, useMemo, useState } from 'react';

import { checkShaderModule, shadertoyFileSource, validateShaderModule } from '../../engine/modules/shader-module.ts';
import { addLayer } from '../../project/commands.ts';
import { createModuleLayer } from '../../project/create.ts';
import { newId } from '../../project/ids.ts';
import { useStudio } from '../store.ts';

const EXAMPLE = `// Paste a shader's "Image" code from shadertoy.com here.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    float bass = texture(iChannel0, vec2(0.02, 0.25)).x;   // iChannel0 is the music
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0, 2, 4));
    fragColor = vec4(col * (0.4 + bass), 1.0);
}
`;

let checkContext: WebGL2RenderingContext | null | undefined;
/** One small context for every check, made on first use. */
function checker(): WebGL2RenderingContext | null {
  if (checkContext === undefined) checkContext = document.createElement('canvas').getContext('webgl2');
  return checkContext;
}

export function ShadertoyDialog(): React.JSX.Element | null {
  const open = useStudio((s) => s.shadertoyOpen);
  const setOpen = useStudio((s) => s.setShadertoyOpen);
  const notify = useStudio((s) => s.notify);
  const [name, setName] = useState('My shader');
  const [code, setCode] = useState(EXAMPLE);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Live compile errors: checked a moment after typing stops.
  const source = useMemo(() => shadertoyFileSource(`${name}.glsl`, code), [name, code]);
  useEffect(() => {
    if (!open) return;
    const handle = setTimeout(() => {
      const problems = validateShaderModule(source, new Set());
      if (problems.length > 0) {
        setResult({ ok: false, text: problems.join('\n') });
        return;
      }
      const gl = checker();
      if (gl === null) {
        setResult({ ok: false, text: 'WebGL2 is not available here to check the shader.' });
        return;
      }
      const error = checkShaderModule(gl, source);
      // The message leads with "modules/<file>: the shader does not compile." — the rest is the log.
      setResult(error === null ? { ok: true, text: 'Compiles.' } : { ok: false, text: error.replace(/^modules\/[^\n]*\n/, '') });
    }, 300);
    return () => clearTimeout(handle);
  }, [open, source]);

  if (!open) return null;

  async function add(): Promise<void> {
    setBusy(true);
    try {
      const saved = await window.pulseforge.addShadertoy({ name, code });
      const state = useStudio.getState();
      // The module must be registered before a layer uses it, or the preview reports it unknown.
      await state.loadModules();
      const layer = createModuleLayer(saved.id, { id: newId(), name: saved.fileName.replace(/\.glsl$/i, '') });
      state.run(addLayer(layer));
      state.select(layer.id);
      notify({ text: `Added "${saved.fileName}" as a layer. Edit modules/${saved.fileName} and it reloads.`, kind: 'ok' });
      // The dialog stays mounted while closed: the next paste starts from the example again.
      setName('My shader');
      setCode(EXAMPLE);
      setOpen(false);
    } catch (error) {
      notify({ text: `Could not add the shader. ${error instanceof Error ? error.message : String(error)}`, kind: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal shadertoy-dialog" role="dialog" aria-label="Paste a Shadertoy" onClick={(event) => event.stopPropagation()}>
        <h2>Paste a Shadertoy</h2>
        <p className="dim-text">
          iTime, iResolution, iFrame and iChannel0 (the music: spectrum in row 0) work as on the site. Single
          pass only; other channels are black. The shader is saved in modules/ and added as a layer.
        </p>
        <label className="field">
          <span>Name</span>
          <input data-action="shadertoy-name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <textarea
          className="shadertoy-code"
          data-action="shadertoy-code"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <pre className={result?.ok === true ? 'shadertoy-result ok' : 'shadertoy-result bad'} data-testid="shadertoy-result">
          {result === null ? 'Checking…' : result.text}
        </pre>
        <div className="modal-actions">
          <button type="button" onClick={() => setOpen(false)}>Close</button>
          <button type="button" className="primary" data-action="shadertoy-add" disabled={busy || result?.ok !== true} onClick={() => void add()}>
            Add as layer
          </button>
        </div>
      </div>
    </div>
  );
}
