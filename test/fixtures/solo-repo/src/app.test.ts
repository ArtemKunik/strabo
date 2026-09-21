import { run } from './app';

test('run doubles', () => {
  expect(run(2)).toBe(4);
});
