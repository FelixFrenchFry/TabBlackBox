import { expect, it } from 'vitest';
import { matchRanges } from '../../src/ui/highlight';
import { displayUrl } from '../../src/ui/site-label';

it('marks every case-insensitive occurrence and merges overlapping words', () =>
{
  expect(matchRanges('Software and HARDWARE', ['war'])).toEqual([[4, 7], [17, 20]]);
  expect(matchRanges('hardware', ['war', 'ware', 'hard'])).toEqual([[0, 8]]);
  expect(matchRanges('a.b (c)', ['.', '(c)'])).toEqual([[1, 2], [4, 7]]);
  expect(matchRanges('Example', [])).toEqual([]);
});

it('lists web addresses without their scheme', () =>
{
  expect(displayUrl('https://github.com/a?b=1')).toBe('github.com/a?b=1');
  expect(displayUrl('HTTP://example.test/')).toBe('example.test/');
  expect(displayUrl('file:///C:/paper.pdf')).toBe('file:///C:/paper.pdf');
});
