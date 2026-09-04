import test from 'node:test';
import assert from 'node:assert/strict';

test('health route module loads', async () => {
  const { default: app } = await import('../src/index.js');
  assert.ok(app, 'express app should export');
});
