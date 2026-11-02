// A template: a disc that swells with the beat. Folders starting with "_" are not loaded — copy
// this one, rename it without the underscore, then change the id in module.json.

void main() {
  vec2 p = (pf_uv() - 0.5) * u_resolution / u_scale;
  float radius = u_size * (1.0 + 0.3 * u_beat);
  float alpha = 1.0 - smoothstep(radius - 0.005, radius, length(p));
  outColor = vec4(u_color * alpha, alpha);
}
