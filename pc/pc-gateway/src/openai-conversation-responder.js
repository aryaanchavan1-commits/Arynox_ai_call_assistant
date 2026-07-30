const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_HISTORY_MESSAGES = 12;

function boundedText(value, name, max = 4_000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

export function extractResponseText(payload) {
  if (!Array.isArray(payload?.output)) return '';
  return payload.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((item) => item?.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('')
    .trim();
}

export class OpenAiConversationResponder {
  constructor({
    apiKey,
    model = DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxHistoryMessages = DEFAULT_MAX_HISTORY_MESSAGES,
  } = {}) {
    if (typeof apiKey !== 'string' || apiKey.length < 20 || apiKey.length > 512) {
      throw new Error('OpenAI API key is invalid');
    }
    if (!MODEL_RE.test(model)) throw new Error('OpenAI conversation model is invalid');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
      throw new Error('OpenAI conversation timeout is invalid');
    }
    if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages < 2 || maxHistoryMessages > 40) {
      throw new Error('OpenAI conversation history limit is invalid');
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
    const input = [...this.history, { role: 'user', content: userText }];

    try {
      const response = await this.fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          instructions: [
            'You are having a friendly live telephone conversation.',
            identity,
            memory,
            'Reply naturally in one or two short spoken sentences, normally under 30 words.',
            'Do not use markdown, lists, headings, stage directions, or emoji.',
            'If speech is unclear, briefly ask the caller to repeat it.',
            'Never claim you performed an action that you did not perform.',
          ].join(' '),
          input,
          max_output_tokens: 80,
        }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        const code = typeof payload?.error?.code === 'string' ? payload.error.code.slice(0, 80) : 'request_failed';
        throw new Error(`OpenAI conversation request failed (${response.status}, ${code})`);
      }
      const reply = extractResponseText(payload);
      if (!reply || reply.length > 1_000) throw new Error('OpenAI conversation response is invalid');
      this.remember('user', userText);
      this.remember('assistant', reply);
      return reply;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    }
  }
}
