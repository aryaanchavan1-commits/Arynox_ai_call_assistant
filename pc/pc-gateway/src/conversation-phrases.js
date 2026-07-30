const TERMINAL_OR_URGENT = /\b(?:bye|goodbye|hang\s*up|end (?:the )?call|talk (?:to you )?later|emergency|urgent|ambulance|police|fire brigade|in danger|can['’]?t breathe|chest pain|suicid(?:e|al))\b/iu;
const SIMPLE_TURN = /^(?:hi|hello|hey|yes|no|okay|ok|thanks|thank you|who are you|what is your name|tell me your name(?: please)?)[.!? ]*$/iu;
const WAIT_COMPLAINT = /\b(?:too much time|taking (?:too )?long|why (?:is|are) (?:it|you) so slow|hurry up|still waiting|reply faster)\b/iu;
const INCOMPLETE_TURN = /(?:[,;:]|\b(?:and|but|or|because|so|that|this|is|are|was|were|my|your|the|a|an|to|of|for|with|about|like|not))\s*[.!?]*$/iu;
const CLOSING_TURN = /\b(?:thanks? for (?:calling|the call)|thank you for (?:calling|the call)|that(?:'s| is) all)\b/iu;

const SCENARIOS = Object.freeze([
  Object.freeze({
    name: 'social',
    pattern: /^(?:how are you(?: doing)?|(?:yeah,?\s+)?(?:i am|i'm) (?:fine|good|okay)|(?:i am |i'm )?doing (?:fine|good|okay)|nice to meet you|(?:that is |that's )?good to hear)[.!?]*$/iu,
    phrases: Object.freeze([
      'I am glad to hear that.',
      'That is good to hear.',
      'I am pleased to hear that.',
      'Good, I am glad you are doing well.',
    ]),
  }),
  Object.freeze({
    name: 'lookup',
    pattern: /\b(?:check|find|search|look up|verify|weather|price|latest|when|where|availability|status)\b/iu,
    phrases: Object.freeze([
      'Sure, let me check that.',
      'Of course, I am looking into that now.',
      'All right, give me a moment to check.',
      'Let me pull that together for you.',
    ]),
  }),
  Object.freeze({
    name: 'troubleshooting',
    pattern: /\b(?:not working|doesn['’]?t work|problem|issue|error|failed|broken|fix|troubleshoot|stuck|cannot connect|can['’]?t connect)\b/iu,
    phrases: Object.freeze([
      'I see. Let me look into that.',
      'Got it. Let me think through what might be happening.',
      'All right, let me work through the issue.',
      'I understand. Give me a moment to trace that.',
    ]),
  }),
  Object.freeze({
    name: 'reasoning',
    pattern: /\b(?:think|thought|opinion|why|reason|explain|compare|consider|what do you make of)\b/iu,
    phrases: Object.freeze([
      'Hmm, that is a good question. Let me think.',
      'Let me think that through for a moment.',
      'There are a couple of angles to that. Let me consider them.',
      'That is worth thinking about carefully.',
    ]),
  }),
  Object.freeze({
    name: 'planning',
    pattern: /\b(?:plan|approach|strategy|next step|what should|how should|decide|decision|choose)\b/iu,
    phrases: Object.freeze([
      'Okay, let me work through that.',
      'Let me think about the best way to approach it.',
      'All right, let me put the steps in order.',
      'Give me a moment to shape a practical plan.',
    ]),
  }),
  Object.freeze({
    name: 'recommendation',
    pattern: /\b(?:recommend|suggest|best option|which one|worth buying|better choice|pick)\b/iu,
    phrases: Object.freeze([
      'Sure, let me weigh the options.',
      'Let me think about what would fit best.',
      'All right, I am comparing the practical tradeoffs.',
      'Give me a moment to narrow that down.',
    ]),
  }),
  Object.freeze({
    name: 'scheduling',
    pattern: /\b(?:schedule|appointment|meeting|calendar|available|free time|tomorrow|next week|date|time works)\b/iu,
    phrases: Object.freeze([
      'Sure, let me work out the timing.',
      'All right, let me check the details around that.',
      'Give me a moment to line up the schedule.',
      'Let me think about the most practical time.',
    ]),
  }),
  Object.freeze({
    name: 'calculation',
    pattern: /\b(?:calculate|total|percentage|cost|budget|estimate|how much|how many|difference)\b/iu,
    phrases: Object.freeze([
      'Sure, let me work that out.',
      'Give me a moment to calculate it carefully.',
      'All right, let me check the numbers.',
      'Let me make sure I get the calculation right.',
    ]),
  }),
  Object.freeze({
    name: 'prior_context',
    pattern: /\b(?:earlier|before|previous|last time|what we discussed|you said|I told you|remember)\b/iu,
    phrases: Object.freeze([
      'Yes, let me connect that with what we discussed earlier.',
      'I remember the earlier point. Let me bring it together.',
      'Give me a moment to connect the previous context.',
      'Right, let me pick up from where we left off.',
    ]),
  }),
  Object.freeze({
    name: 'creative',
    pattern: /\b(?:idea|brainstorm|write|draft|create|name for|design|imagine)\b/iu,
    phrases: Object.freeze([
      'That sounds interesting. Let me think of a good direction.',
      'Sure, give me a moment to shape an idea.',
      'All right, let me come up with something that fits.',
      'Let me think creatively about that.',
    ]),
  }),
  Object.freeze({
    name: 'sensitive',
    pattern: /\b(?:worried|upset|sad|difficult|hard time|concerned|frustrated|anxious|stressed)\b/iu,
    phrases: Object.freeze([
      'I hear you. Let me think about that carefully.',
      'I understand. Give me a moment to respond properly.',
      'That sounds difficult. Let me think it through with you.',
      'I see why that matters. Let me consider it carefully.',
    ]),
  }),
  Object.freeze({
    name: 'how_to',
    pattern: /\b(?:how do I|how can I|how would I|show me how|steps to|help me)\b/iu,
    phrases: Object.freeze([
      'Sure, let me make that clear and practical.',
      'All right, let me walk through the best way.',
      'Give me a moment to put the steps together.',
      'Let me explain that in a simple way.',
    ]),
  }),
]);

function normalizedWords(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 4_000) return null;
  return { normalized, lower: normalized.toLocaleLowerCase(), words: normalized.split(' ').length };
}

export function contextualAcknowledgementOptions(value) {
  const parsed = normalizedWords(value);
  if (!parsed || TERMINAL_OR_URGENT.test(parsed.lower) || CLOSING_TURN.test(parsed.lower)
      || INCOMPLETE_TURN.test(parsed.lower) || SIMPLE_TURN.test(parsed.lower)) {
    return Object.freeze([]);
  }
  if (WAIT_COMPLAINT.test(parsed.lower)) {
    return Object.freeze([
      "You're right. I'm responding now.",
      "You're right. Let me answer that now.",
    ]);
  }
  const scenario = SCENARIOS.find(({ pattern }) => pattern.test(parsed.lower));
  if (scenario) return scenario.phrases;
  if (parsed.words >= 4 && /[?]$/u.test(parsed.normalized)) {
    return Object.freeze([
      'Hmm, let me think about that.',
      'That is a thoughtful question. Give me a moment.',
      'All right, let me consider that properly.',
      'Let me gather my thoughts for a moment.',
    ]);
  }
  if (parsed.words >= 3) {
    return Object.freeze([
      'I understand. Give me a moment.',
      'All right, let me think about that.',
      'Got it. Let me respond properly.',
      'I hear you. Let me think that through.',
    ]);
  }
  return Object.freeze([]);
}

export function contextualAcknowledgement(value, variant = 0) {
  const options = contextualAcknowledgementOptions(value);
  if (options.length === 0) return null;
  const index = Number.isSafeInteger(variant) && variant >= 0 ? variant % options.length : 0;
  return options[index];
}

export function contextualAcknowledgementFollowUp(value) {
  const parsed = normalizedWords(value);
  if (!parsed || TERMINAL_OR_URGENT.test(parsed.lower) || CLOSING_TURN.test(parsed.lower)
      || WAIT_COMPLAINT.test(parsed.lower)
      || INCOMPLETE_TURN.test(parsed.lower) || SIMPLE_TURN.test(parsed.lower)) {
    return null;
  }
  const scenario = SCENARIOS.find(({ pattern }) => pattern.test(parsed.lower))?.name;
  if (scenario === 'social') return null;
  if (scenario === 'lookup' || scenario === 'scheduling' || scenario === 'calculation') {
    return "I'm checking that now.";
  }
  if (scenario === 'troubleshooting') return "I'm working through it now.";
  if (scenario === 'sensitive') return "I'm thinking about how to respond carefully.";
  return "I'm putting the answer together now.";
}

export function standardAcknowledgementOptions() {
  const primary = SCENARIOS.map(({ phrases }) => phrases[0]);
  return Object.freeze([...new Set([
    ...primary,
    'Hmm, let me think about that.',
    'I understand. Give me a moment.',
    "You're right. I'm responding now.",
    "I'm checking that now.",
    "I'm working through it now.",
    "I'm thinking about how to respond carefully.",
    "I'm putting the answer together now.",
  ])]);
}

export function naturalGreeting({ callerName, now = new Date() } = {}) {
  const hour = now.getHours();
  const salutation = hour >= 5 && hour < 12
    ? 'Good morning'
    : (hour < 17 ? 'Good afternoon' : (hour < 22 ? 'Good evening' : 'Hello'));
  const safeName = typeof callerName === 'string'
    ? callerName.replace(/[\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 80)
    : '';
  return `${salutation}${safeName ? `, ${safeName}` : ''}. How are you?`;
}

export function standardGreetingOptions() {
  return Object.freeze([
    'Good morning. How are you?',
    'Good afternoon. How are you?',
    'Good evening. How are you?',
    'Hello. How are you?',
  ]);
}
