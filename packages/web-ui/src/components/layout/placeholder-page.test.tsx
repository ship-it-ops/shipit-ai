import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaceholderPage } from './placeholder-page';

describe('PlaceholderPage', () => {
  it('shows the default roadmap note when none is given', () => {
    render(<PlaceholderPage title="Audit Log" description="d" glyph="file" />);
    expect(
      screen.getByText(/This screen is a placeholder\. The underlying capability/i),
    ).toBeInTheDocument();
  });

  it('shows a custom note instead of the default one', () => {
    render(
      <PlaceholderPage title="Agents" description="d" glyph="bot" note="Agents are being built." />,
    );
    expect(screen.getByText('Agents are being built.')).toBeInTheDocument();
    expect(screen.queryByText(/The underlying capability/i)).not.toBeInTheDocument();
  });
});
