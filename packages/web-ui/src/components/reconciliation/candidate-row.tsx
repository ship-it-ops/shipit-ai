'use client';

import { Badge, Button, Card, formatRelative } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { ReconciliationCandidate } from '@/lib/api';

export interface CandidateRowProps {
  candidate: ReconciliationCandidate;
  onOpen: (id: string) => void;
}

function confidenceVariant(c: number) {
  if (c >= 0.95) return 'err' as const;
  if (c >= 0.9) return 'warn' as const;
  return 'accent' as const;
}

export function CandidateRow({ candidate, onOpen }: CandidateRowProps) {
  return (
    <Card className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2">
        <Badge size="sm" variant="neutral">
          {candidate.label}
        </Badge>
        <Badge size="sm" variant={confidenceVariant(candidate.confidence)}>
          {(candidate.confidence * 100).toFixed(1)}% match
        </Badge>
      </header>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-[13px]">
        <Side name={candidate.leftName} id={candidate.leftId} source={candidate.leftSource} />
        <span className="text-text-dim">↔</span>
        <Side name={candidate.rightName} id={candidate.rightId} source={candidate.rightSource} />
      </div>
      <footer className="flex items-center justify-between">
        <span className="text-text-dim text-[11px]">
          created {formatRelative(candidate.createdAt)}
        </span>
        <Button size="sm" variant="outline" onClick={() => onOpen(candidate.id)}>
          Open <IconGlyph name="next" size={10} />
        </Button>
      </footer>
    </Card>
  );
}

function Side({ name, id, source }: { name: string; id: string; source: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-text font-medium">{name}</span>
      <span className="text-text-dim font-mono text-[10px]">{id}</span>
      {source && (
        <Badge size="sm" variant="accent">
          {source}
        </Badge>
      )}
    </div>
  );
}
