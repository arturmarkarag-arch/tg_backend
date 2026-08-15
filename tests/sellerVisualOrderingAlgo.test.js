'use strict';

const { buildVisualSequence, mergeFrozenSequenceWithEligible } = require('../services/sellerVisualOrderingAlgo');

describe('seller visual ordering V48.1', () => {
  const familySet = [
    { id: 'plate-a', orderNumber: 1, vector: [1, 0, 0], model: 'm', dim: 3 },
    { id: 'fork-a', orderNumber: 2, vector: [0, 1, 0], model: 'm', dim: 3 },
    { id: 'toy-a', orderNumber: 3, vector: [0, 0, 1], model: 'm', dim: 3 },
    { id: 'plate-b', orderNumber: 4, vector: [0.999, 0.01, 0], model: 'm', dim: 3 },
    { id: 'fork-b', orderNumber: 5, vector: [0.01, 0.999, 0], model: 'm', dim: 3 },
    { id: 'toy-b', orderNumber: 6, vector: [0, 0.01, 0.999], model: 'm', dim: 3 },
  ];

  test('keeps visually close families next to each other and is deterministic', () => {
    const first = buildVisualSequence(familySet).ids;
    const second = buildVisualSequence(familySet).ids;
    const adjacent = (a, b) => Math.abs(first.indexOf(a) - first.indexOf(b)) === 1;
    expect(adjacent('plate-a', 'plate-b')).toBe(true);
    expect(adjacent('fork-a', 'fork-b')).toBe(true);
    expect(adjacent('toy-a', 'toy-b')).toBe(true);
    expect(second).toEqual(first);
  });

  test('missing embeddings never break catalogue and stay at stable tail', () => {
    const result = buildVisualSequence([
      { id: 'a', orderNumber: 1, vector: [1, 0], model: 'm', dim: 2 },
      { id: 'b', orderNumber: 2, vector: [0.99, 0.01], model: 'm', dim: 2 },
      { id: 'legacy', orderNumber: 9 },
    ]).ids;
    expect(result.at(-1)).toBe('legacy');
  });

  test('frozen sequence only removes unavailable products; it does not reshuffle survivors', () => {
    expect(mergeFrozenSequenceWithEligible(
      ['a', 'b', 'c', 'd'],
      [{ id: 'a' }, { id: 'c' }, { id: 'd' }],
    )).toEqual(['a', 'c', 'd']);
  });

  test('unexpected new eligible legacy product is appended instead of reshuffling frozen cycle', () => {
    expect(mergeFrozenSequenceWithEligible(
      ['a', 'b'],
      [{ id: 'a', orderNumber: 1 }, { id: 'b', orderNumber: 2 }, { id: 'c', orderNumber: 3 }],
    )).toEqual(['a', 'b', 'c']);
  });
});
