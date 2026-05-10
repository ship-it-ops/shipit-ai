'use client';

import { useState } from 'react';
import {
  AskBar,
  Citation,
  ConfidenceIndicator,
  CopilotMessage,
  ReasoningBlock,
  ReasoningStep,
  SuggestionChip,
  ToolCallCard,
} from '@ship-it-ui/shipit';
import {
  FOLLOW_UP_SUGGESTIONS,
  MOCK_MESSAGES,
  SCOPE_SUGGESTIONS,
  type MockAssistantMessage,
  type MockMessage,
} from './mock-conversation';

export function AskShell() {
  const [messages] = useState<ReadonlyArray<MockMessage>>(MOCK_MESSAGES);

  return (
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 p-6">
      <header>
        <h1 className="text-text text-[22px] font-semibold tracking-tight">Ask</h1>
        <p className="text-text-muted text-[13px]">
          Ask the knowledge graph about services, owners, deployments, and incidents.
        </p>
      </header>

      <AskBar
        placeholder="Ask anything about your software ecosystem…"
        onSubmit={(value) => {
          // TODO: wire to backend stream
          console.info('[mock ask]', value);
        }}
      >
        {SCOPE_SUGGESTIONS.map((s) => (
          <SuggestionChip key={s}>{s}</SuggestionChip>
        ))}
      </AskBar>

      <div className="flex flex-col gap-4">
        {messages.map((msg, i) => (
          <MessageRow key={i} message={msg} />
        ))}
      </div>

      <div className="flex flex-wrap gap-[6px] pt-2">
        {FOLLOW_UP_SUGGESTIONS.map((s) => (
          <SuggestionChip key={s}>{s}</SuggestionChip>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: MockMessage }) {
  if (message.role === 'user') {
    return (
      <CopilotMessage role="user" avatar={message.who.charAt(0)}>
        {message.text}
      </CopilotMessage>
    );
  }
  return <AssistantMessageBody message={message} />;
}

function AssistantMessageBody({ message }: { message: MockAssistantMessage }) {
  return (
    <CopilotMessage role="assistant">
      <p className="m-0">
        {message.preface}{' '}
        <Citation inline index={1} source={message.citations[0]?.source} />
      </p>

      <div className="mt-3">
        <ReasoningBlock duration={message.reasoningDuration} stepCount={message.reasoning.length}>
          {message.reasoning.map((s) => (
            <ReasoningStep key={s.step} step={s.step}>
              {s.text}
            </ReasoningStep>
          ))}
        </ReasoningBlock>
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {message.toolCalls.map((tc) => (
          <ToolCallCard key={tc.name} name={tc.name} status={tc.status}>
            {tc.args}
          </ToolCallCard>
        ))}
      </div>

      <p className="mt-3 mb-0">
        {message.closing}{' '}
        <Citation inline index={2} source={message.citations[1]?.source} />
      </p>

      <ul className="mt-3 mb-0 flex list-none flex-col gap-1 p-0">
        {message.citations.map((c) => (
          <li key={c.index}>
            <Citation index={c.index} source={c.source} meta={c.meta} />
          </li>
        ))}
      </ul>

      <div className="mt-3">
        <ConfidenceIndicator value={message.confidence} />
      </div>
    </CopilotMessage>
  );
}
