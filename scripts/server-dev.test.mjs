import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SERVER_DEV_OPTIONS, parseServerDevArgs } from './server-dev.mjs';

test('server dev defaults to the bundled walkthrough world', () => {
  assert.deepEqual(parseServerDevArgs([]), { ...DEFAULT_SERVER_DEV_OPTIONS });
});

test('server dev parses world, ports, cache, interval, and switches', () => {
  assert.deepEqual(parseServerDevArgs([
    '--world', 'C:\\minecraft\\world',
    '--cache', 'tmp/cache',
    '--viewer-port', '9000',
    '--server-port', '9001',
    '--scan-interval', '5',
    '--no-open',
    '--skip-build',
    '--smoke',
  ]), {
    world: 'C:\\minecraft\\world',
    cache: 'tmp/cache',
    viewerPort: 9000,
    serverPort: 9001,
    scanInterval: 5,
    open: false,
    build: false,
    smoke: true,
  });
});

test('smoke mode never opens a browser', () => {
  assert.equal(parseServerDevArgs(['--smoke']).open, false);
  assert.equal(parseServerDevArgs(['--smoke']).smoke, true);
});

test('server dev rejects unsafe or ambiguous port configuration', () => {
  assert.throws(() => parseServerDevArgs(['--viewer-port', '0']), /1 to 65535/);
  assert.throws(
    () => parseServerDevArgs(['--viewer-port', '9000', '--server-port', '9000']),
    /must be different/,
  );
});

test('server dev reports missing values and unknown options', () => {
  assert.throws(() => parseServerDevArgs(['--world']), /requires a value/);
  assert.throws(() => parseServerDevArgs(['--wat']), /unknown option/);
});
