import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './sidebar';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/explore',
}));

describe('Sidebar', () => {
  it('renders all top-level nav items', () => {
    render(<Sidebar />);
    expect(screen.getByRole('link', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /graph explorer/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /ask/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /connector hub/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /incident mode/i })).toBeInTheDocument();
  });

  it('marks the current pathname as the active link', () => {
    render(<Sidebar />);
    const explore = screen.getByRole('link', { name: /graph explorer/i });
    expect(explore.getAttribute('aria-current')).toBe('page');
  });

  it('renders the brand mark', () => {
    render(<Sidebar />);
    expect(screen.getByText('ShipIt-AI')).toBeInTheDocument();
  });
});
