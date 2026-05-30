// Tests for exported pure functions in gworkspace-helper.
// The HTTP-touching functions (buildService, getAuthClient, markProcessedWithLog,
// checkPriorOutboundToRecipient, assertNoRecentDuplicateOutbound) are NOT tested
// here — they need OAuth credentials + real Gmail state. Wrap those in
// integration tests against a sandbox account if you need that coverage.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { encodeHeaderRfc2047, SCOPES } = require('../index.js');

// ---------- encodeHeaderRfc2047 ----------

test('encodeHeaderRfc2047: pure ASCII passes through unchanged', () => {
  assert.equal(encodeHeaderRfc2047('Hello World'), 'Hello World');
  assert.equal(encodeHeaderRfc2047('Re: Q3 invoice 1234-5678'), 'Re: Q3 invoice 1234-5678');
  assert.equal(encodeHeaderRfc2047(''), '');
});

test('encodeHeaderRfc2047: non-ASCII gets B-encoded with UTF-8', () => {
  const out = encodeHeaderRfc2047('Naïve résumé');
  assert.match(out, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
});

test('encodeHeaderRfc2047: emoji triggers encoding', () => {
  const out = encodeHeaderRfc2047('Status update 🚀');
  assert.match(out, /^=\?UTF-8\?B\?/);
});

test('encodeHeaderRfc2047: roundtrip decodes back to the original (smoke check)', () => {
  // Decode the B-encoded portion and confirm we get the original bytes back.
  const original = 'Café résumé naïve';
  const encoded = encodeHeaderRfc2047(original);
  const m = encoded.match(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
  assert.ok(m, 'expected B-encoded form');
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  assert.equal(decoded, original);
});

// ---------- SCOPES ----------

test('SCOPES is a non-empty array of OAuth scope URLs', () => {
  assert.ok(Array.isArray(SCOPES));
  assert.ok(SCOPES.length > 0);
  for (const s of SCOPES) {
    assert.match(s, /^https:\/\/www\.googleapis\.com\/auth\//, `unexpected scope: ${s}`);
  }
});

test('SCOPES includes the core Gmail + Drive scopes', () => {
  const join = SCOPES.join(' ');
  assert.match(join, /gmail/);
  assert.match(join, /drive/);
});
