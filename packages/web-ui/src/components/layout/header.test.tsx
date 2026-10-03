import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/components/layout/user-menu', () => ({ UserMenu: () => null }));

import { trailFor } from './header';

describe('trailFor', () => {
  it('names every AI page under an AI section', () => {
    const pages: Record<string, string> = {
      '/ai/ask': 'Ask',
      '/ai/agents': 'Agents',
      '/ai/workflows': 'Workflows',
      '/ai/activity': 'Activity',
      '/ai/tools': 'Tools',
      '/ai/mcp': 'MCP Access',
    };
    for (const [path, page] of Object.entries(pages)) {
      expect(trailFor(path)).toEqual({ section: { label: 'AI' }, page });
    }
  });

  it('has no trail left for the pre-move routes', () => {
    expect(trailFor('/ask')).toEqual({ page: 'Ask' });
    expect(trailFor('/admin/agent-activity')).toEqual({ page: 'Admin' });
  });

  it('still falls back to the capitalised first segment for unknown paths', () => {
    expect(trailFor('/catalog/abc')).toEqual({ page: 'Catalog' });
    expect(trailFor('/')).toEqual({ page: 'Home' });
  });
});
