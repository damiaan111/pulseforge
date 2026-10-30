// Free space on a drive, for a file that may not exist yet (export-spec §14, M33).

import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Free bytes on the drive that holds `path`; null when it cannot be read. */
export async function freeBytesAt(path: string): Promise<number | null> {
  for (let at = path; ; at = dirname(at)) {
    try {
      const fs = await statfs(at);
      return Number(fs.bavail) * Number(fs.bsize);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || at === dirname(at)) return null;
    }
  }
}
