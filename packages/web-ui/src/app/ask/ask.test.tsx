import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { AskShell } from './ask-shell';

describe('AskShell', () => {
  it('renders the AskBar with the leading sparkle and submit button', () => {
    render(<AskShell />);
    expect(screen.getByRole('search')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^ask$/i })).toBeInTheDocument();
  });

  it('renders the scope and follow-up suggestion chips', () => {
    render(<AskShell />);
    expect(screen.getByText('All services')).toBeInTheDocument();
    expect(screen.getByText('This team')).toBeInTheDocument();
    expect(screen.getByText('Last 24h')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /who owns checkout-svc/i }),
    ).toBeInTheDocument();
  });

  it('renders the mock assistant message body with all AI surfaces', () => {
    render(<AskShell />);
    // ReasoningBlock heading
    expect(screen.getByRole('button', { name: /reasoning · 3 steps/i })).toBeInTheDocument();
    // ToolCallCard names appear in mono
    expect(screen.getByText('search_commits')).toBeInTheDocument();
    expect(screen.getByText('list_deployments')).toBeInTheDocument();
    // ConfidenceIndicator (role="meter")
    expect(screen.getByRole('meter', { name: /confidence/i })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<AskShell />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
