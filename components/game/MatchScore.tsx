import type { RoomView } from '../../lib/socket/events.ts';
import { cn } from '../../lib/utils.ts';

/**
 * The win tally for this session, shown on the table: "Ada 1 – 0 Bola" for two players,
 * "Ada 1 · Bola 0 · Cy 2" for more. Wins come from the server; no running points.
 */
export function MatchScore({ room, className }: { room: RoomView; className?: string }) {
  const wins = new Map(room.scores.map((s) => [s.playerId, s.wins]));
  const rows = room.seats.map((s) => ({ id: s.id, name: s.nickname, wins: wins.get(s.id) ?? 0 }));
  if (rows.length < 2) return null;
  const top = Math.max(...rows.map((r) => r.wins));
  const label = `Match score: ${rows.map((r) => `${r.name} ${r.wins}`).join(', ')}`;

  if (rows.length === 2) {
    const [a, b] = rows;
    return (
      <div role="group" aria-label={label} className={cn('inline-flex items-center gap-2.5 rounded-full border border-white/10 bg-black/30 px-4 py-1.5 text-sm font-semibold', className)}>
        <span className="max-w-[10ch] truncate sm:max-w-[16ch]">{a.name}</span>
        <span className={cn('text-lg font-black tabular-nums', a.wins === top && top > 0 && 'text-gold')}>{a.wins}</span>
        <span className="text-white/50" aria-hidden="true">–</span>
        <span className={cn('text-lg font-black tabular-nums', b.wins === top && top > 0 && 'text-gold')}>{b.wins}</span>
        <span className="max-w-[10ch] truncate sm:max-w-[16ch]">{b.name}</span>
      </div>
    );
  }
  return (
    <div role="group" aria-label={label} className={cn('inline-flex flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-2xl border border-white/10 bg-black/30 px-4 py-1.5 text-sm font-semibold', className)}>
      {rows.map((r) => (
        <span key={r.id} className="inline-flex items-center gap-1.5">
          <span className="max-w-[9ch] truncate sm:max-w-[14ch]">{r.name}</span>
          <span className={cn('text-lg font-black tabular-nums', r.wins === top && top > 0 && 'text-gold')}>{r.wins}</span>
        </span>
      ))}
    </div>
  );
}
