#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GatewayRpcClient } from '../src/gateway-rpc.js';
import { isHangupIntent } from '../src/conversation-turn-policy.js';
import { OpenAiConversationResponder } from '../src/openai-conversation-responder.js';

const E164_RE = /^\+[1-9]\d{7,14}$/;
const phoneNumber = process.env.AGENTCALL_QUALIFICATION_PHONE;
const socketPath = process.env.AGENTCALL_RPC_SOCKET || '\\\\.\\pipe\\agentcall-gatewayd-desktop';
const providerSettingsPath = process.env.AGENTCALL_PROVIDER_SETTINGS_FILE
  || join(process.env.APPDATA || '', 'agentcall-desktop', 'gateway', 'provider-settings.json');
const model = process.env.AGENTCALL_CONVERSATION_MODEL || 'gpt-4o-mini';
const callerName = process.env.AGENTCALL_QUALIFICATION_CALLER_NAME || 'Siddharth';
const turnSettleMs = Number.parseInt(process.env.AGENTCALL_CONVERSATION_TURN_SETTLE_MS || '650', 10);
const maximumCallMs = Number.parseInt(process.env.AGENTCALL_CONVERSATION_MAX_CALL_MS || '300000', 10);
const skipGreeting = process.env.AGENTCALL_QUALIFICATION_SKIP_GREETING === 'yes';

if (process.env.AGENTCALL_QUALIFICATION_CALL_APPROVED !== 'yes') {
  throw new Error('AGENTCALL_QUALIFICATION_CALL_APPROVED=yes is required');
}
if (!E164_RE.test(phoneNumber || '')) {
  throw new Error('AGENTCALL_QUALIFICATION_PHONE must be a valid E.164 number');
}
if (!Number.isInteger(turnSettleMs) || turnSettleMs < 100 || turnSettleMs > 2_000) {
  throw new Error('AGENTCALL_CONVERSATION_TURN_SETTLE_MS must be between 100 and 2000');
}
if (!Number.isInteger(maximumCallMs) || maximumCallMs < 30_000 || maximumCallMs > 30 * 60_000) {
  throw new Error('AGENTCALL_CONVERSATION_MAX_CALL_MS must be between 30000 and 1800000');
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitForEvent(client, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    const handler = (event) => {
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const error = (problem) => {
      cleanup();
      reject(problem);
    };
    function cleanup() {
      clearTimeout(timer);
      client.off('event', handler);
      client.off('eventError', error);
    }
    client.on('event', handler);
    client.on('eventError', error);
  });
}

async function loadOpenAiKey() {
  const settings = JSON.parse(await readFile(providerSettingsPath, 'utf8'));
  const candidates = [settings?.stt, settings?.tts];
  const entry = candidates.find((value) => value?.provider === 'openai' && typeof value.apiKey === 'string');
  if (!entry?.apiKey) throw new Error('OpenAI is not configured in desktop Speech settings');
  return entry.apiKey;
}

async function main() {
  const apiKey = await loadOpenAiKey();
  const responder = new OpenAiConversationResponder({ apiKey, model });
  const client = new GatewayRpcClient({ socketPath, timeoutMs: 60_000 });
  let callId = null;
  let ended = false;
  let pendingRemoteText = [];
  let debounceTimer = null;
  let maximumCallTimer = null;
  let responseAbort = null;
  let turnWork = Promise.resolve();

  const processPendingTurn = () => {
    const text = pendingRemoteText.join(' ').trim();
    pendingRemoteText = [];
    if (!text || ended || !callId) return;
    responseAbort?.abort();
    const controller = new AbortController();
    responseAbort = controller;
    turnWork = turnWork.then(async () => {
      if (controller.signal.aborted || ended) return;
      const startedAt = performance.now();
      try {
        if (isHangupIntent(text)) {
          const farewell = `Thank you for the conversation, ${callerName}. Goodbye.`;
          await client.speak({
            callId,
            text: farewell,
            idempotencyKey: `farewell-${randomUUID()}`,
          }, { signal: controller.signal });
          const receipt = await client.hangup({
            callId,
            idempotencyKey: `farewell-hangup-${randomUUID()}`,
          }, { signal: controller.signal });
          write({
            phase: 'auto_hangup',
            reason: 'remote_goodbye',
            accepted: receipt?.accepted === true,
            totalMs: Math.round(performance.now() - startedAt),
          });
          return;
        }
        const reply = await responder.respond({
          text,
          callerName,
          signal: controller.signal,
        });
        const reasoningMs = Math.round(performance.now() - startedAt);
        if (controller.signal.aborted || ended) return;
        const receipt = await client.speak({
          callId,
          text: reply,
          idempotencyKey: `conversation-${randomUUID()}`,
        }, { signal: controller.signal });
        write({
          phase: 'turn',
          remoteCharacters: text.length,
          replyCharacters: reply.length,
          reasoningMs,
          turnAccepted: receipt?.accepted === true,
          totalMs: Math.round(performance.now() - startedAt),
        });
      } catch (error) {
        if (!controller.signal.aborted && !ended) {
          write({ phase: 'turn_error', reason: String(error?.message || error).slice(0, 200) });
        }
      } finally {
        if (responseAbort === controller) responseAbort = null;
      }
    });
  };

  client.on('event', (event) => {
    if (event?.callId !== callId) return;
    if (event.event === 'transcript_final' && event.speaker === 'remote'
        && typeof event.text === 'string' && event.text.trim()) {
      pendingRemoteText.push(event.text.trim());
      responseAbort?.abort();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(processPendingTurn, turnSettleMs);
      return;
    }
    if (event.event === 'ended') {
      ended = true;
      responseAbort?.abort();
      clearTimeout(debounceTimer);
    }
  });

  try {
    await client.startEvents();
    const status = await client.status();
    if (status.device?.connected !== true) throw new Error('desktop gateway is not connected');
    if (status.currentCall?.phase === 'active' && status.currentCall.direction === 'outgoing') {
      callId = status.currentCall.callId;
      write({ phase: 'attached', callId, model });
    } else {
      if (status.currentCall) throw new Error('another call is already active');
      const dialingEvent = waitForEvent(
        client,
        (event) => event?.event === 'dialing' && event.direction === 'outgoing'
          && typeof event.callId === 'string',
        30_000,
        'outgoing call start',
      );
      const activeOrEndedEvent = waitForEvent(
        client,
        (event) => (event?.event === 'active' && event.direction === 'outgoing')
          || event?.event === 'ended',
        90_000,
        'outgoing call answer',
      );
      const receipt = await client.dial({
        approved: true,
        consent: {
          recorded: true,
          policy: 'explicit operator approval for live conversational qualification',
        },
        destination: phoneNumber,
        idempotencyKey: `qualification-${randomUUID()}`,
      });
      if (receipt?.accepted !== true) {
        throw new Error(`dial refused: ${receipt?.reason || 'unknown'}`);
      }
      callId = (await dialingEvent).callId;
      write({ phase: 'dialing', callId, model });
      const callEvent = await activeOrEndedEvent;
      if (callEvent.event === 'ended') throw new Error('outgoing call ended before answer');
    }
    write({ phase: 'active', callId });
    maximumCallTimer = setTimeout(() => {
      if (ended) return;
      responseAbort?.abort();
      turnWork = turnWork.then(async () => {
        if (ended) return;
        try {
          await client.speak({
            callId,
            text: `We have reached the five minute call limit. Thank you, ${callerName}. Goodbye.`,
            idempotencyKey: `maximum-${randomUUID()}`,
          });
          const receipt = await client.hangup({
            callId,
            idempotencyKey: `maximum-hangup-${randomUUID()}`,
          });
          write({
            phase: 'auto_hangup',
            reason: 'maximum_duration',
            accepted: receipt?.accepted === true,
          });
        } catch (error) {
          if (!ended) write({ phase: 'hangup_error', reason: String(error?.message || error).slice(0, 200) });
        }
      });
    }, maximumCallMs);
    maximumCallTimer.unref?.();
    if (!skipGreeting) {
      const greeting = `Hello ${callerName}. I have switched to the low-latency conversation path. How does the response speed feel now?`;
      responder.remember('assistant', greeting);
      await client.speak({
        callId,
        text: greeting,
        idempotencyKey: `greeting-${randomUUID()}`,
      });
    }
    while (!ended) {
      await waitForEvent(
        client,
        (event) => event?.callId === callId && event.event === 'ended',
        30 * 60_000,
        'call end',
      );
      ended = true;
    }
    await turnWork;
    write({ phase: 'ended', callId });
  } finally {
    ended = true;
    responseAbort?.abort();
    clearTimeout(debounceTimer);
    clearTimeout(maximumCallTimer);
    client.stopEvents();
  }
}

main().catch((error) => {
  write({ phase: 'failed', reason: String(error?.message || error).slice(0, 240) });
  process.exitCode = 1;
});
