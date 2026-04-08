import { describe, expect, it } from 'vitest';

import { requireArrayValue, requireDefined } from '../src/required.js';

describe('required helpers', () => {
  it('returns defined values unchanged', () => {
    expect(requireDefined('value', 'missing')).toBe('value');
    expect(requireArrayValue(['a', 'b'], 1, 'missing')).toBe('b');
  });

  it('throws for nullish values and missing array indexes', () => {
    expect(() => requireDefined(undefined, 'missing value')).toThrow('missing value');
    expect(() => requireDefined(null, 'missing value')).toThrow('missing value');
    expect(() => requireArrayValue(['a'], 3, 'missing index')).toThrow('missing index');
  });
});
