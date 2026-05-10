// TODO: replace with backend stream when /api/ask is wired up.
// This mock seed exercises every AI surface in @ship-it-ui/shipit so the page
// renders the full conversation shape without needing a model in the loop.

export interface MockReasoningStep {
  step: number;
  text: string;
}

export interface MockToolCall {
  name: string;
  status: string;
  args: string;
}

export interface MockCitation {
  index: number;
  source: string;
  meta: string;
}

export interface MockAssistantMessage {
  role: 'assistant';
  preface: string;
  reasoning: ReadonlyArray<MockReasoningStep>;
  reasoningDuration: string;
  toolCalls: ReadonlyArray<MockToolCall>;
  closing: string;
  citations: ReadonlyArray<MockCitation>;
  confidence: number;
}

export interface MockUserMessage {
  role: 'user';
  text: string;
  who: string;
}

export type MockMessage = MockUserMessage | MockAssistantMessage;

export const SCOPE_SUGGESTIONS = ['All services', 'This team', 'Last 24h'] as const;

export const FOLLOW_UP_SUGGESTIONS = [
  'Who owns checkout-svc?',
  'Show recent deploys for this team',
  'What changed in payments-api this week?',
] as const;

export const MOCK_MESSAGES: ReadonlyArray<MockMessage> = [
  {
    role: 'user',
    who: 'Mohamed',
    text: 'What changed in checkout-svc this week?',
  },
  {
    role: 'assistant',
    preface:
      'Two changes landed in `checkout-svc` over the past 7 days, both from the payments team:',
    reasoning: [
      { step: 1, text: 'Resolved `checkout-svc` to canonical id `svc_3a91`.' },
      { step: 2, text: 'Searched commits on default branch since 2026-05-02.' },
      { step: 3, text: 'Joined commit metadata to deployment events for prod.' },
    ],
    reasoningDuration: '1.8s',
    toolCalls: [
      {
        name: 'search_commits',
        status: '94ms · 14 results',
        args: 'service: checkout-svc\nsince: 2026-05-02\nbranch: main',
      },
      {
        name: 'list_deployments',
        status: '62ms · 3 results',
        args: 'service: checkout-svc\nenv: production\nsince: 2026-05-02',
      },
    ],
    closing:
      'Both changes were rolled out in the 2026-05-08 release; success rate held at 99.97%.',
    citations: [
      { index: 1, source: 'github · ship-it/checkout-svc@a7f3c1', meta: 'merged 2d ago' },
      { index: 2, source: 'argo · checkout-svc-prod-7421', meta: 'deployed 1d ago' },
    ],
    confidence: 96.4,
  },
];
