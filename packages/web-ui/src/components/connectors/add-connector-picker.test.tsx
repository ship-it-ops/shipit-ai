import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddConnectorPicker } from './add-connector-picker';

describe('AddConnectorPicker', () => {
  it('offers Kubernetes as a selectable type, not "coming soon"', async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<AddConnectorPicker open onOpenChange={() => {}} onPick={onPick} />);

    const kubernetes = screen.getByRole('button', {
      name: /kubernetes — namespaces, deployments/i,
    });
    expect(kubernetes).toBeEnabled();
    await user.click(kubernetes);
    expect(onPick).toHaveBeenCalledWith('kubernetes');
  });

  // The picker lists the roadmap on purpose, so the unimplemented entries must
  // stay visible AND stay unpickable.
  it('still lists an unimplemented type as coming soon', () => {
    render(<AddConnectorPicker open onOpenChange={() => {}} onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: /datadog — coming soon/i })).toBeDisabled();
  });
});
