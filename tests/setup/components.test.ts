// What a person chooses from (setup/components.ts), and the rules the chooser applies to it.

import { describe, expect, it } from 'vitest';

import { COMPONENTS, NON_COMMERCIAL_NOTICE, componentInstalled, resolveChoice } from '../../setup/components.ts';
import { EXTRAS } from '../../setup/manifest.ts';
import { blockedReason, withRequirements } from '../../src/ui/components/ComponentChooser.tsx';

const rows = COMPONENTS.map((component) => ({ ...component, installed: false }));

describe('the choices', () => {
  it('offers every optional model, with a size and a licence', () => {
    expect(COMPONENTS.filter((c) => c.group === 'model').map((c) => c.id).sort()).toEqual([...EXTRAS].sort());
    for (const component of COMPONENTS) {
      expect(component.bytes, component.id).toBeGreaterThan(0);
      expect(component.license, component.id).not.toBe('');
    }
  });

  it('marks exactly the four VoxPopuli models non-commercial, and says what that means', () => {
    expect(COMPONENTS.filter((c) => c.nonCommercial).map((c) => c.id)).toEqual(['align-fr', 'align-de', 'align-es', 'align-it']);
    expect(NON_COMMERCIAL_NOTICE).toMatch(/non-commercial/);
    expect(NON_COMMERCIAL_NOTICE).toMatch(/English/);
  });

  it('lets beat refinement run with no NVIDIA card', () => {
    expect(COMPONENTS.find((c) => c.id === 'beats')?.minDriver).toBeNull();
  });
});

describe('resolving a choice', () => {
  it('always includes the essentials', () => {
    expect(resolveChoice([]).tiers).toEqual(['core']);
  });

  it('brings what a model needs, and the extras tier', () => {
    const choice = resolveChoice(['align-fr']);
    expect(choice.tiers).toEqual(['core', 'lyrics', 'extras']);
    expect(choice.extras).toEqual(['align-fr']);
  });

  it('does not bring torch with beat refinement', () => {
    expect(resolveChoice(['beats']).tiers).toEqual(['core', 'beats']);
  });

  it('names what does not exist', () => {
    expect(() => resolveChoice(['nope'])).toThrow(/Unknown component "nope"/);
  });
});

describe('what is installed', () => {
  it('reads files, so a deleted folder shows as gone', () => {
    expect(componentInstalled('core', () => true)).toBe(true);
    expect(componentInstalled('core', () => false)).toBe(false);
    expect(componentInstalled('beats', (path) => path.endsWith('.pulseforge-beats-env.json'))).toBe(true);
    expect(componentInstalled('nope', () => true)).toBe(false);
  });
});

describe('the chooser', () => {
  const stems = { minDriver: 580 };

  it('says what stops a component on this PC', () => {
    expect(blockedReason({ minDriver: null }, null)).toBeNull();
    expect(blockedReason(stems, null)).toMatch(/NVIDIA graphics card/);
    expect(blockedReason(stems, { name: 'RTX', version: '560.94', major: 560 })).toBe('Needs NVIDIA driver 580 or newer; this PC has 560.94.');
    expect(blockedReason(stems, { name: 'RTX', version: '581.10', major: 581 })).toBeNull();
  });

  it('ticks what a choice needs, without losing the choice', () => {
    expect([...withRequirements(new Set(['align-de']), rows)].sort()).toEqual(['align-de', 'lyrics']);
    expect([...withRequirements(new Set(['beats']), rows)]).toEqual(['beats']);
  });
});
