import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedCatalogEntry,
  boundedFinalizedCatalog,
  canOpenFinalizedRecording,
} from '../lib/catalog.js';

const finalized = {
  callId: 'call-1',
  complete: true,
  outcome: 'completed',
  durationMillis: 12_345,
  retention: { deleteAfter: '2026-08-01T00:00:00.000Z' },
  artifacts: ['remote.wav', 'agent.wav', 'conversation.mkv'],
};

test('catalog normalizer accepts only bounded finalized recording metadata', () => {
  assert.deepEqual(boundedCatalogEntry(finalized), finalized);
  assert.equal(boundedCatalogEntry({ ...finalized, complete: false }), null);
  assert.equal(boundedCatalogEntry({ ...finalized, complete: undefined }), null);
  assert.equal(boundedCatalogEntry({ ...finalized, callId: '../escape' }), null);
  assert.equal(boundedCatalogEntry({ ...finalized, callId: { toString: () => 'call-1' } }), null);
  assert.equal(boundedCatalogEntry({ ...finalized, callId: 123 }), null);
  assert.equal(boundedCatalogEntry({ ...finalized, durationMillis: -1 }), null);
  assert.equal(boundedCatalogEntry({ ...finalized, durationMillis: '12345' }), null);
  assert.equal(boundedCatalogEntry({ ...finalized, durationMillis: true }), null);
});

test('catalog normalizer filters incomplete entries and unrecognized artifacts', () => {
  const recordings = boundedFinalizedCatalog([
    finalized,
    { ...finalized, callId: 'partial', complete: false },
    {
      ...finalized,
      callId: 'bounded-2',
      outcome: 'x'.repeat(100),
      retention: { deleteAfter: 'y'.repeat(100) },
      artifacts: ['conversation.mkv', '/etc/passwd', 'unknown.wav'],
    },
    null,
  ]);

  assert.equal(recordings.length, 2);
  assert.deepEqual(recordings[1], {
    callId: 'bounded-2',
    complete: true,
    outcome: 'x'.repeat(64),
    durationMillis: 12_345,
    retention: { deleteAfter: 'y'.repeat(64) },
    artifacts: ['conversation.mkv'],
  });
  assert.deepEqual(boundedFinalizedCatalog(null), []);
});

test('recording open eligibility requires an allowlisted conversation artifact', () => {
  assert.equal(canOpenFinalizedRecording(finalized), true);
  assert.equal(canOpenFinalizedRecording({ ...finalized, artifacts: [] }), false);
  assert.equal(canOpenFinalizedRecording({ ...finalized, artifacts: undefined }), false);
  assert.equal(canOpenFinalizedRecording({ ...finalized, artifacts: 'conversation.mkv' }), false);
  assert.equal(canOpenFinalizedRecording({ ...finalized, artifacts: ['/etc/passwd'] }), false);
  assert.equal(canOpenFinalizedRecording({ ...finalized, complete: false }), false);
});
