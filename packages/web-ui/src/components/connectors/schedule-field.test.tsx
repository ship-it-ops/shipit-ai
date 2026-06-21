import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ScheduleField } from './schedule-field';
import { WARNING_TEXT } from '@/lib/schedule';

describe('ScheduleField', () => {
  it('shows the custom cron input (and no warning) for a non-preset schedule', () => {
    render(<ScheduleField value="15,45 * * * *" onChange={() => {}} />);
    // Custom mode is derived from a non-preset value, so the raw input shows.
    expect(screen.getByLabelText('Custom cron schedule')).toHaveValue('15,45 * * * *');
    expect(screen.queryByText(WARNING_TEXT)).not.toBeInTheDocument();
  });

  it('warns (without blocking) when the cadence is too frequent', () => {
    render(<ScheduleField value="*/5 * * * *" onChange={() => {}} />);
    expect(screen.getByText(WARNING_TEXT)).toBeInTheDocument();
    // The input is still present and editable — the warning never disables it.
    expect(screen.getByLabelText('Custom cron schedule')).toBeEnabled();
  });

  it('does not warn for a 30-minute preset', () => {
    render(<ScheduleField value="*/30 * * * *" onChange={() => {}} />);
    expect(screen.queryByText(WARNING_TEXT)).not.toBeInTheDocument();
    // A preset value renders the dropdown rather than the raw cron input.
    expect(screen.queryByLabelText('Custom cron schedule')).not.toBeInTheDocument();
  });

  it('emits raw cron edits via onChange', () => {
    const onChange = vi.fn();
    render(<ScheduleField value="*/5 * * * *" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Custom cron schedule'), {
      target: { value: '*/10 * * * *' },
    });
    expect(onChange).toHaveBeenCalledWith('*/10 * * * *');
  });
});
