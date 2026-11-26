import type { Tier } from '../manifest.ts';
import type { VendorLock } from '../lib/lockfile.ts';
import type { Logger } from '../lib/log.ts';

export interface StepContext {
  log: Logger;
  lock: VendorLock;
  /** --from: take pinned files from this folder instead of the network. */
  fromDir: string | undefined;
  /** --relock: regenerate the Python requirements lock before installing. */
  relock: boolean;
}

export interface PlanRow {
  name: string;
  version: string;
  download: string;
  source: string;
  destination: string;
  status: string;
}

export interface Step {
  id: string;
  title: string;
  tier: Tier;
  /** Other tiers that need this step: the Python interpreter serves every tier that runs Python. */
  alsoFor?: readonly Tier[];
  /** What --plan shows. Must not touch the network or change anything. */
  describe(lock: VendorLock): Promise<PlanRow>;
  run(ctx: StepContext): Promise<void>;
  /** --verify: re-check what is installed, offline, without changing anything. */
  verify(ctx: StepContext): Promise<void>;
}
