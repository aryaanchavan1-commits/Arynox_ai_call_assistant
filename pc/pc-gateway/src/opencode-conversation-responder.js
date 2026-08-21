const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const DEFAULT_MODEL = 'big-pickle';
const ZEN_CHAT_COMPLETIONS_URL = 'https://opencode.ai/zen/v1/chat/completions';
export const FREE_MODELS = Object.freeze(new Set([
  DEFAULT_MODEL,
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'nemotron-3-ultra-free',
  'north-mini-code-free',
  'longcat-2.0-free',
  'ling-3.0-flash-free',
]));
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_HISTORY_MESSAGES = 12;
const SYSTEM_INSTRUCTIONS = Object.freeze([
  'You are Arynox, a friendly AI assistant having a live telephone conversation.',
  'Reply naturally in one or two short spoken sentences, normally under 30 words.',
  'Do not use markdown, lists, headings, stage directions, or emoji.',
  'If speech is unclear, briefly ask the caller to repeat it.',
  'Never claim you performed an action that you did not perform.',
]);

function boundedText(value, name, max = 4_000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

export class OpenCodeConversationResponder {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
  } = {}) {
    if (typeof apiKey !== 'string' || apiKey.length < 20 || apiKey.length > 512) {
      throw new Error('OpenCode Zen API key is invalid');
    }
    if (typeof model !== 'string' || !MODEL_RE.test(model)) {
      throw new Error('OpenCode Zen conversation model is invalid');
    }
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
      throw new Error('OpenCode Zen conversation timeout is invalid');
    }
    if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages < 2 || maxHistoryMessages > 40) {
      throw new Error('OpenCode Zen conversation history limit is invalid');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxHistoryMessages = maxHistoryMessages;
    this.history = [];
  }

  remember(role, text) {
    if (role !== 'user' && role !== 'assistant') throw new Error('conversation role is invalid');
    this.history.push({ role, content: boundedText(text, 'conversation text') });
    if (this.history.length > this.maxHistoryMessages) {
      this.history.splice(0, this.history.length - this.maxHistoryMessages);
    }
  }

  async respond({ text, callerName, callerContext, signal } = {}) {
    const userText = boundedText(text, 'remote transcript');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener?.('abort', abort, { once: true });
    const timer = setTimeout(abort, this.timeoutMs);
    timer.unref?.();

    const identity = typeof callerName === 'string' && callerName.trim()
      ? `The caller's name is ${callerName.trim().slice(0, 100)}.`
      : 'The caller name is unavailable.';
    const memory = typeof callerContext === 'string' && callerContext.trim()
      ? ` Relevant prior-call context: ${callerContext.trim().slice(0, 2_000)}`
      : '';
    const messages = [
      { role: 'system', content: [...SYSTEM_INSTRUCTIONS, identity, memory].join(' ') },
      ...this.history,
      { role: 'user', content: userText },
    ];

    try {
      const response = await this.fetch(ZEN_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: 80,
        }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        const code = typeof payload?.error?.code === 'string' ? payload.error.code.slice(0, 80) : 'request_failed';
        throw new Error(`OpenCode Zen conversation request failed (${response.status}, ${code})`);
      }
      const content = payload?.choices?.[0]?.message?.content;
      const reply = typeof content === 'string' ? content.trim() : '';
      if (!reply || reply.length > 1_000) throw new Error('OpenCode Zen conversation response is invalid');
      this.remember('user', userText);
      this.remember('assistant', reply);
      return reply;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  }
}

export default OpenCodeConversationResponder;