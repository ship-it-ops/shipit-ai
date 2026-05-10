import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  it('flips data-theme on the html element when toggled', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    expect(document.documentElement.dataset.theme).toBeUndefined();

    const switchEl = screen.getByRole('switch', { name: /toggle light theme/i });
    await user.click(switchEl);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    await user.click(switchEl);
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('writes the shipit-theme cookie on toggle', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const switchEl = screen.getByRole('switch', { name: /toggle light theme/i });
    await user.click(switchEl);
    expect(document.cookie).toMatch(/shipit-theme=light/);
  });

  it('has no axe violations', async () => {
    const { container } = render(<ThemeToggle />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
