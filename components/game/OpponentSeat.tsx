import { Crown, WifiOff } from 'lucide-react';
import type { ReactionEvent } from '../../lib/socket/events.ts';
import { cn } from '../../lib/utils.ts';
import { PlayerAvatar } from './PlayerAvatar.tsx';
import { ReactionBubble } from './Reactions.tsx';
import { CardBack } from './WhotCard.tsx';

interface Props {
  name: string;
  handCount: number;
  active: boolean;
  connected: boolean;
  isHost: boolean;
  isBot?: boolean;
  reaction?: ReactionEvent;
}

/** Small warning tag shared by seats and the player's own hand box. */
export function LastCardTag({ className }: { className?: string }) {
  return (
    <span className={cn('pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 rounded-full bg-red-500 px-2.5 py-0.5 text-[10px] font-black tracking-wider whitespace-nowrap text-white shadow-md', className)}>
      LAST CARD
    </span>
  );
}

export function OpponentSeat({ name, handCount, active, connected, isHost, isBot, reaction }: Props) {
  const shown = Math.min(handCount, 6);
  const lastCard = handCount === 1;
  return (
    <div
      className={cn(
        'relative grid min-w-0 justify-items-center gap-1.5 rounded-2xl border border-white/10 bg-black/25 px-2.5 pt-2.5 pb-2 backdrop-blur-[1px] transition-colors',
        active && 'animate-pulse-ring border-gold bg-gold/10',
        lastCard && 'animate-last-card border-2 border-red-400 bg-red-500/10',
        !connected && 'opacity-55',
      )}
      aria-label={`${name}${isBot ? ' (computer)' : ''}, ${handCount} card${handCount === 1 ? '' : 's'}${lastCard ? ', last card' : ''}${active ? ', their turn' : ''}${connected ? '' : ', disconnected'}`}
    >
      {lastCard ? <LastCardTag className="-top-2.5" /> : null}
      <ReactionBubble reaction={reaction} />
      <div className="flex max-w-full items-center gap-2">
        <PlayerAvatar name={name} size="sm" bot={isBot} />
        <span className="flex min-w-0 items-center gap-1 text-sm font-semibold">
          {isHost ? <Crown className="size-3.5 shrink-0 text-gold" aria-label="Host" /> : null}
          <span className="max-w-[9ch] truncate sm:max-w-[13ch]">{name}</span>
          {!connected ? <WifiOff className="size-3.5 shrink-0" aria-label="Disconnected" /> : null}
        </span>
      </div>
      <div className="flex" aria-hidden="true">
        {Array.from({ length: shown }, (_, i) => (
          <CardBack key={i} size="xs" className={i ? '-ml-4' : ''} />
        ))}
      </div>
      <span className="rounded-full bg-black/40 px-2 py-0.5 text-xs font-medium text-white/80">{handCount} card{handCount === 1 ? '' : 's'}</span>
    </div>
  );
}
