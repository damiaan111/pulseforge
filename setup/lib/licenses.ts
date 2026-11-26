import { writeFile } from 'node:fs/promises';
import type { VendorLock } from './lockfile.ts';
import { LICENSES_MD } from './paths.ts';

/** vendor/LICENSES.md: every fetched artefact and its licence (PROJECT.md §3). */
export async function writeLicenses(lock: VendorLock): Promise<void> {
  const escape = (s: string) => s.replace(/\|/g, '\\|');
  const lines = [
    '# Third-party components installed by `npm run setup`',
    '',
    'Generated from `vendor/vendor.lock.json`. Do not edit; re-run setup to regenerate.',
    '',
    '## Artefacts',
    '',
    '| Component | Version | Licence | Source |',
    '|---|---|---|---|',
    ...lock.artefacts.map((a) => `| ${escape(a.name)} | ${escape(a.version)} | ${escape(a.license)} | ${a.url} |`),
  ];
  if (lock.pythonEnv !== null) {
    lines.push(
      '',
      `## Python packages (vendor/python, Python ${lock.pythonEnv.python})`,
      '',
      'Licences as declared in each package\'s own metadata.',
      '',
      '| Package | Version | Licence |',
      '|---|---|---|',
      ...lock.pythonEnv.packages.map((p) => `| ${escape(p.name)} | ${escape(p.version)} | ${escape(p.license)} |`),
    );
  }
  await writeFile(LICENSES_MD, lines.join('\n') + '\n');
}
