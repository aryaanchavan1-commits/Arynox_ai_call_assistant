(function webBridge() {
  'use strict';

  const RPC_URL = '/rpc';
  const EVENTS_URL = '/events';
  const PROJECT_URL = 'https://github.com/aryaanchavan1-commits/Arynox_ai_call_assistant';

  function uuid() {
    return crypto.randomUUID();
  }

  async function rpc(method, args) {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, args: args ?? {} }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error('gateway web bridge response is invalid');
    }
    if (!payload || payload.ok !== true) {
      throw new Error(payload?.error ?? 'gateway web bridge request failed');
    }
    return payload.result;
  }

  async function read(resource, id) {
    const unavailable = {
      mode: 'unavailable',
      reason: 'gatewayd unavailable',
      ...(resource === 'mcp' ? { integration: null } : {}),
    };
    try {
      if (resource === 'storage') {
        return { mode: 'live', recordings: await rpc('listRecordings', { limit: 100 }) };
      }
      if (resource === 'contacts') {
        return { mode: 'live', ...(await rpc('listContacts', { limit: 500 })) };
      }
      if (resource === 'callLog') {
        return { mode: 'live', ...(await rpc('listCallLog', { limit: 200 })) };
      }
      if (resource === 'stt' || resource === 'tts') {
        const provider = await rpc('providerStatus');
        return {
          mode: 'live',
          kind: resource,
          state: provider.state,
          configured: provider.configured,
          enabled: provider.enabled,
          restartRequired: provider.restartRequired,
          ...provider[resource],
        };
      }
      if (resource === 'agentAnswering') {
        return { mode: 'live', ...(await rpc('agentAnsweringStatus')) };
      }
      const status = await rpc('status');
      if (resource === 'overview') return { mode: 'live', gateway: status };
      if (resource === 'android') return { mode: 'live', device: status.device ?? { connected: false } };
      const capabilities = await rpc('capabilities');
      if (resource === 'mcp') return { mode: 'live', status, capabilities, integration: null };
      return { mode: 'live', status, capabilities };
    } catch {
      return unavailable;
    }
  }

  async function copyText(text) {
    if (typeof navigator?.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(String(text));
      return { copied: true };
    }
    throw new Error('clipboard unavailable');
  }

  async function call(action, callId, value) {
    if (action === 'dial') {
      const result = await rpc('dial', {
        destination: callId,
        approved: true,
        consent: { recorded: true, policy: 'desktop user confirmed recorded call' },
        idempotencyKey: uuid(),
      });
      return { ...result, fixture: false, deviceAction: true };
    }
    const method = action === 'dtmf' ? 'sendDtmf' : action;
    const args = action === 'dtmf'
      ? { callId, digits: value, idempotencyKey: uuid() }
      : { callId, idempotencyKey: uuid() };
    const result = await rpc(method, args);
    return { ...result, fixture: false, deviceAction: true };
  }

  async function playRecording(callId) {
    let artifact = 'conversation.wav';
    let response = await fetch(`/api/recording?callId=${encodeURIComponent(callId)}&artifact=conversation.wav`);
    if (!response.ok) {
      artifact = 'conversation.mkv';
      response = await fetch(`/api/recording?callId=${encodeURIComponent(callId)}&artifact=conversation.mkv`);
    }
    if (!response.ok) throw new Error('recording artifact unavailable');
    const blob = await response.blob();
    return { accepted: true, action: 'playback', callId, mediaUrl: URL.createObjectURL(blob), artifact };
  }

  async function saveRecording(callId) {
    const playback = await playRecording(callId);
    const anchor = document.createElement('a');
    anchor.href = playback.mediaUrl;
    anchor.download = `Arynox-${callId}${playback.artifact.endsWith('.mkv') ? '.mkv' : '.wav'}`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return { accepted: true, canceled: false, action: 'save', callId };
  }

  const gatewayDesktop = Object.freeze({
    read,
    copyText,
    call,
    dial: (destination) => call('dial', destination),
    startManualAudio: async (callId) => ({ connected: false, callId }),
    pushManualAudio: async () => { throw new Error('manual audio is not connected'); },
    stopManualAudio: async (callId) => ({ connected: false, callId }),
    onManualAudio: () => () => {},
    onManualAudioClosed: () => () => {},
    onGatewayEvent: (callback) => {
      if (typeof callback !== 'function') throw new TypeError('gateway event callback must be a function');
      const source = new EventSource(EVENTS_URL);
      source.onmessage = (message) => {
        let frame;
        try {
          frame = JSON.parse(message.data);
        } catch {
          return;
        }
        if (frame && typeof frame === 'object' && frame.event && typeof frame.event === 'object') {
          callback(frame.event);
        }
      };
      return () => source.close();
    },
    playRecording,
    saveRecording,
    syncRecording: (callId) => rpc('syncRecording', { callId }),
    deleteRecording: (callId) => rpc('deleteRecording', { callId }),
    authorizeDownload: async (callId) => {
      throw new Error(`recording download is unavailable for ${callId}`);
    },
    checkProviderHealth: (kind) => rpc('providerHealth', { kind }),
    loadProviderCatalog: (kind, provider, model) => rpc(
      'providerCatalog',
      { kind, provider, ...(model === undefined ? {} : { model }) },
    ),
    testProviders: async () => {
      const result = await rpc('testProviders');
      return {
        healthy: result?.healthy === true,
        phrase: String(result?.phrase ?? ''),
        transcript: String(result?.transcript ?? ''),
        sttProvider: String(result?.sttProvider ?? ''),
        ttsProvider: String(result?.ttsProvider ?? ''),
        sampleRate: result?.sampleRate,
        samples: result?.samples,
        playbackOpened: false,
      };
    },
    openProjectPage: async () => {
      window.open(PROJECT_URL, '_blank', 'noopener');
      return { opened: true };
    },
    saveSecret: async (config) => {
      const result = await rpc('configureProvider', config);
      return {
        accepted: result?.accepted === true,
        kind: config?.kind,
        provider: config?.provider,
        configured: result?.configured === true,
        restartRequired: result?.restartRequired === true,
      };
    },
    saveAgentAnswering: async (config) => {
      const result = await rpc('configureAgentAnswering', config);
      return {
        accepted: true,
        enabled: result?.enabled === true,
        instructions: String(result?.instructions ?? ''),
      };
    },
    onNavigate: () => () => {},
  });

  window.gatewayDesktop = gatewayDesktop;
})();