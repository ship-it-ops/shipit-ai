import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WelcomeDialog } from './welcome-dialog';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe('WelcomeDialog', () => {
  it('greets the user by first name', () => {
    render(<WelcomeDialog open onOpenChange={() => {}} displayName="Mohamed El-Malah" />);
    expect(screen.getByText('Welcome, Mohamed')).toBeInTheDocument();
  });

  it('renders every tip icon as a real glyph, never the literal-name fallback', () => {
    // IconGlyph draws unregistered names as centered SVG <text> (clipped to
    // ~3 characters — the "tal" bug from "catalog"). A welcome dialog icon
    // must always resolve to a registered glyph path.
    const { baseElement } = render(
      <WelcomeDialog open onOpenChange={() => {}} displayName="Mohamed" />,
    );
    const fallbackTexts = baseElement.querySelectorAll('svg text');
    expect(Array.from(fallbackTexts).map((t) => t.textContent)).toEqual([]);
  });
});
