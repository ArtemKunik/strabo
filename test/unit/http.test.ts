import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAllowedHostHeader, isSameOriginHeader } from '../../src/api/http.ts';

test('isAllowedHostHeader allows loopback and a configured host, refuses everything else', () => {
  assert.equal(isAllowedHostHeader(undefined), true);
  assert.equal(isAllowedHostHeader('127.0.0.1:4173'), true);
  assert.equal(isAllowedHostHeader('localhost:4173'), true);
  assert.equal(isAllowedHostHeader('attacker.example', '127.0.0.1'), false);
  assert.equal(isAllowedHostHeader('example.internal:4173', 'example.internal'), true);
  assert.equal(isAllowedHostHeader('192.168.1.5:4173', '0.0.0.0'), true);
  assert.equal(isAllowedHostHeader('attacker.example', '0.0.0.0'), false);
});

test('isSameOriginHeader accepts a matching or absent Origin, refuses a mismatched one', () => {
  assert.equal(isSameOriginHeader(undefined, 'http://attacker.example'), true);
  assert.equal(isSameOriginHeader('127.0.0.1:4173', undefined), true);
  assert.equal(isSameOriginHeader('127.0.0.1:4173', 'http://127.0.0.1:4173'), true);
  assert.equal(isSameOriginHeader('127.0.0.1:4173', 'http://attacker.example'), false);
  assert.equal(isSameOriginHeader('127.0.0.1:4173', 'not a url'), false);
});
