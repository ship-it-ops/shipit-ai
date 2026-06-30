import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@ship-it-ui/ui';
import { FeedbackWidget } from './feedback-widget';

vi.mock('next/navigation', () => ({
  usePathname: () => '/catalog',
}));

vi.mock('@/lib/api', () => ({
  fetchFeedbackConfig: vi.fn(),
  submitFeedback: vi.fn(),
}));
import { fetchFeedbackConfig, submitFeedback } from '@/lib/api';

// jsdom clipboard noop (some DS primitives touch it).
Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

function renderWidget() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <FeedbackWidget />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('FeedbackWidget', () => {
  beforeEach(() => {
    vi.mocked(fetchFeedbackConfig).mockReset();
    vi.mocked(submitFeedback).mockReset();
  });

  it('renders nothing when feedback is disabled', async () => {
    vi.mocked(fetchFeedbackConfig).mockResolvedValue({ enabled: false });
    renderWidget();
    // Give the query a tick to resolve.
    await waitFor(() => expect(fetchFeedbackConfig).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /report a problem/i })).not.toBeInTheDocument();
  });

  it('shows the launcher and opens the form when enabled', async () => {
    vi.mocked(fetchFeedbackConfig).mockResolvedValue({ enabled: true });
    renderWidget();
    const fab = await screen.findByRole('button', { name: /report a problem/i });
    fireEvent.click(fab);
    expect(await screen.findByText(/tell us what went wrong/i)).toBeInTheDocument();
    // Send is disabled until title + description are filled.
    expect(screen.getByRole('button', { name: /send report/i })).toBeDisabled();
  });

  it('submits the report with context + logs and toasts the issue link', async () => {
    vi.mocked(fetchFeedbackConfig).mockResolvedValue({ enabled: true });
    vi.mocked(submitFeedback).mockResolvedValue({
      issueUrl: 'https://github.com/x/issues/9',
      issueNumber: 9,
    });
    renderWidget();
    fireEvent.click(await screen.findByRole('button', { name: /report a problem/i }));

    fireEvent.change(await screen.findByPlaceholderText(/short summary/i), {
      target: { value: 'Filter crashes' },
    });
    fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
      target: { value: 'It throws on click.' },
    });

    const send = screen.getByRole('button', { name: /send report/i });
    await waitFor(() => expect(send).not.toBeDisabled());
    fireEvent.click(send);

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(submitFeedback).mock.calls[0][0];
    expect(payload.type).toBe('bug');
    expect(payload.title).toBe('Filter crashes');
    expect(payload.description).toBe('It throws on click.');
    expect(payload.context?.route).toBe('/catalog');
    expect(Array.isArray(payload.logs)).toBe(true);

    expect(await screen.findByText(/report filed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view issue/i })).toHaveAttribute(
      'href',
      'https://github.com/x/issues/9',
    );
  });

  it('shows an error toast when submission fails', async () => {
    vi.mocked(fetchFeedbackConfig).mockResolvedValue({ enabled: true });
    vi.mocked(submitFeedback).mockRejectedValue(new Error('Please wait a moment'));
    renderWidget();
    fireEvent.click(await screen.findByRole('button', { name: /report a problem/i }));
    fireEvent.change(await screen.findByPlaceholderText(/short summary/i), {
      target: { value: 'x' },
    });
    fireEvent.change(screen.getByPlaceholderText(/what happened/i), {
      target: { value: 'y' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    expect(await screen.findByText(/please wait a moment/i)).toBeInTheDocument();
  });
});
