// A budget of calls per owner per UTC day, kept in this process's memory.
//
// It is what `backend.mcp.rateLimits.graphQueryPerDay` promises for the
// network surface, as far as one process can keep it: the count starts again
// when the process does, and each replica counts for itself.
export class DailyBudget {
  private readonly used = new Map<string, { day: string; count: number }>();

  constructor(
    readonly perDay: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Takes one call from `owner`'s budget for today. False when it is spent. */
  take(owner: string): boolean {
    const day = this.now().toISOString().slice(0, 10);
    const entry = this.used.get(owner);
    const count = entry?.day === day ? entry.count : 0;
    if (count >= this.perDay) return false;
    this.used.set(owner, { day, count: count + 1 });
    return true;
  }
}
