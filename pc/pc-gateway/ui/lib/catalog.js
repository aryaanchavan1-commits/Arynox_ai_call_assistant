const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACTS = new Set(['remote.wav', 'agent.wav', 'conversation.mkv', 'conversation.wav']);

export function boundedCatalogEntry(recording) {
  if (!recording || typeof recording !== 'object' || recording.complete !== true) return null;
  if (typeof recording.callId !== 'string' || !CALL_ID.test(recording.callId)) return null;
  if (typeof recording.durationMillis !== 'number'
      || !Number.isSafeInteger(recording.durationMillis) || recording.durationMillis < 0) return null;
  const { durationMillis } = recording;
  const artifacts = Array.isArray(recording.artifacts)
    ? recording.artifacts.filter((name) => ARTIFACTS.has(name))
    : [];
  return {
    callId: recording.callId,
    complete: true,
    outcome: typeof recording.outcome === 'string' ? recording.outcome.slice(0, 64) : 'unknown',
    durationMillis,
    retention: typeof recording.retention?.deleteAfter === 'string'
      ? { deleteAfter: recording.retention.deleteAfter.slice(0, 64) }
      : null,
    artifacts,
  };
}

export function boundedFinalizedCatalog(recordings) {
  return (Array.isArray(recordings) ? recordings : [])
    .map(boundedCatalogEntry)
    .filter(Boolean);
}

export function canOpenFinalizedRecording(recording) {
  const artifacts = boundedCatalogEntry(recording)?.artifacts ?? [];
  return artifacts.includes('conversation.wav') || artifacts.includes('conversation.mkv');
}
