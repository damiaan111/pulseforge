// Pulse rings — the worked example from docs/module-authoring.md.
//
// Everything the prelude declares is available here: u_resolution, u_time, u_frame, u_scale,
// the audio features (u_rms, u_peak, u_onset, u_beat, u_centroid) for the stem chosen by the
// first `select:stem` parameter, pf_spectrum(), pf_uv(), pf_hash(), and one uniform per
// parameter in module.json (u_color, u_spacing, …). Write premultiplied, linear colour to outColor.

void main() {
  // Canvas units, centred: 1.0 is the layer's reference length (u_scale pixels), so the rings
  // keep their size when the canvas changes shape.
  vec2 p = (pf_uv() - 0.5) * u_resolution / u_scale;
  float r = length(p);

  // enum parameters arrive as the option's index: 0 beat, 1 level, 2 onsets.
  float level = u_react == 0 ? u_beat : (u_react == 1 ? u_rms : u_onset);

  // Rings drift outward over time. Time comes from the engine, never a clock, so any frame renders
  // the same whether it was played to or scrubbed to.
  float phase = r / u_spacing - u_time * u_speed;
  float distance = abs(fract(phase) - 0.5) * u_spacing;
  float ring = 1.0 - smoothstep(u_width * 0.5, u_width, distance);

  // Each ring is lit by the part of the spectrum at its radius: bass in the middle, treble outside.
  float band = pf_spectrum(clamp(r / u_radius, 0.0, 1.0));
  float fade = 1.0 - smoothstep(u_radius * 0.8, u_radius, r);
  float alpha = ring * fade * clamp(0.25 + 0.5 * level + 0.75 * band, 0.0, 1.0);

  // Premultiplied: colour times alpha.
  outColor = vec4(u_color * alpha, alpha);
}
