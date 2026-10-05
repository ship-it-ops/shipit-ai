import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResultGrid } from './result-grid';

const RESULT = {
  columns: ['n'],
  rows: [{ n: null }, { n: 'api' }],
  executionTimeMs: 4,
  truncated: false,
  rowLimit: 1000,
};

describe('ResultGrid', () => {
  it('says how many values the server withheld because they are internal nodes', () => {
    const { rerender } = render(<ResultGrid result={{ ...RESULT, withheld: 1 }} error={null} />);
    expect(screen.getByText('1 internal node withheld')).toBeInTheDocument();

    rerender(<ResultGrid result={{ ...RESULT, withheld: 3 }} error={null} />);
    expect(screen.getByText('3 internal nodes withheld')).toBeInTheDocument();
  });

  it('says nothing about withheld values when there are none', () => {
    const { rerender } = render(<ResultGrid result={{ ...RESULT, withheld: 0 }} error={null} />);
    expect(screen.queryByText(/withheld/)).not.toBeInTheDocument();

    // An API server from before the field existed.
    rerender(<ResultGrid result={RESULT} error={null} />);
    expect(screen.queryByText(/withheld/)).not.toBeInTheDocument();
  });
});
