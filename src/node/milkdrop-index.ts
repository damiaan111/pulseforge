// The MilkDrop presets setup installed, by name, for whatever runs the auto-director outside the
// studio's page.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MILKDROP_JS_DIR } from '../../setup/lib/paths.ts';

export function installedMilkdrop(): string[] {
  const file = join(MILKDROP_JS_DIR, 'index.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')) as { name: string }[]).map((preset) => preset.name);
}
