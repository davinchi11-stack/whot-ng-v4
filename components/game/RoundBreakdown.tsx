import { ArrowDown, Crown } from 'lucide-react';
import type { GameResult } from '../../lib/game/types.ts';
import { cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { PlayerAvatar } from './PlayerAvatar.tsx';
import { ShapeIcon } from './ShapeIcon.tsx';

/**
 * The count for one round: each player's remaining cards with their values and the total.
 * The lowest total wins; the highest total is flagged. No points are carried over.
 */
export function RoundBreakdown({ result, names, youId, bots }: { result: GameResult; names: Record<string, string>; youId: string; bots?: Set<string> }) {
  const name = (id: string) => names[id] ?? 'Former player';
  const totals = result.ranking.map((r) => r.total);
  const lowest = Math.min(...totals);
  const highest = Math.max(...totals);
  const showHighest = highest > lowest;
  const low = result.ranking.filter((r) => r.total === lowest);
  const high = showHighest ? result.ranking.filter((r) => r.total === highest) : [];

  return (
    <div className="grid gap-3">
      <p className="text-sm" role="status">
        <span className="font-bold text-gold">Lowest:</span> {low.map((r) => `${name(r.playerId)} (${r.total})`).join(', ')}
        {showHighest ? (
          <>
            {' · '}
            <span className="font-bold text-red-300">Highest:</span> {high.map((r) => `${name(r.playerId)} (${r.total})`).join(', ')}
          </>
        ) : null}
      </p>
      <ol className="grid gap-2.5" aria-label="Round count, lowest total first">
        {result.ranking.map((r) => {
          const isLow = r.total === lowest;
          const isHigh = showHighest && r.total === highest;
          return (
            <li key={r.playerId} className={cn('rounded-xl border bg-black/20 p-3', isLow && 'border-gold/70 bg-gold/10 ring-1 ring-gold/40', isHigh && 'border-red-400/50 bg-red-500/10')}>
              <div className="flex items-center gap-2.5">
                <PlayerAvatar name={name(r.playerId)} size="sm" bot={bots?.has(r.playerId)} />
                <span className="min-w-0 flex-1 truncate text-sm font-bold">
                  {name(r.playerId)}{r.playerId === youId ? ' (you)' : ''}
                </span>
                {isLow ? <Badge variant="gold"><Crown aria-hidden="true" /> Lowest</Badge> : null}
                {isHigh ? <Badge variant="danger"><ArrowDown className="rotate-180" aria-hidden="true" /> Highest</Badge> : null}
                <span className="min-w-10 text-right text-xl font-extrabold tabular-nums" aria-label={`Total ${r.total}`}>{r.total}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-9">
                {r.hand.length === 0 ? (
                  <span className="text-xs font-medium text-muted-foreground">Went out — no cards left</span>
                ) : (
                  r.hand.map((h, i) => (
                    <span key={`${h.card.id}-${i}`} className="inline-flex items-center gap-1 rounded-md border border-maroon-deep/60 bg-cream px-1.5 py-0.5 text-xs font-extrabold text-maroon" aria-label={`${h.card.shape} ${h.card.number}, counts ${h.value}`}>
                      <ShapeIcon shape={h.card.shape} size={11} />
                      {h.value}
                    </span>
                  ))
                )}
                {r.hand.length > 1 ? <span className="ml-1 text-xs text-muted-foreground">= {r.hand.map((h) => h.value).join(' + ')}</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
