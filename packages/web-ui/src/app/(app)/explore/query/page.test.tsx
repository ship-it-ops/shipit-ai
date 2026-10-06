import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import QueryPlaygroundPage from './page';

const { mockUser } = vi.hoisted(() => ({ mockUser: { role: 'admin' } }));
vi.mock('@/lib/current-user', () => ({ useCurrentUser: () => mockUser }));
vi.mock('@/lib/api', () => ({ runCypherQuery: vi.fn() }));

describe('QueryPlaygroundPage', () => {
  beforeEach(() => {
    mockUser.role = 'admin';
  });

  it('offers the editor to an administrator', () => {
    render(<QueryPlaygroundPage />);
    expect(screen.getByRole('button', { name: /run query/i })).toBeInTheDocument();
  });

  it('tells a member the playground is for administrators, with no editor', () => {
    mockUser.role = 'member';
    render(<QueryPlaygroundPage />);
    expect(screen.getByText('For administrators')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run query/i })).not.toBeInTheDocument();
  });

  it('shows nothing decisive while the identity is still loading', () => {
    mockUser.role = '';
    render(<QueryPlaygroundPage />);
    expect(screen.queryByRole('button', { name: /run query/i })).not.toBeInTheDocument();
    expect(screen.queryByText('For administrators')).not.toBeInTheDocument();
  });
});
