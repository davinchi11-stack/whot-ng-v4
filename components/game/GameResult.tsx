import { LogOut, RotateCcw, Trophy } from 'lucide-react';
import type { ReactionEvent, RoomView } from '../../lib/socket/events.ts';
import { Button } from '../ui/button.tsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.tsx';
import { ReactionAnnouncer, ReactionBubble, ReactionPicker } from './Reactions.tsx';
import { RoundBreakdown } from './RoundBreakdown.tsx';
import { MatchScore } from './MatchScore.tsx';

const REASON: Record<string, string> = {
  'out-of-cards': 'A player played their last card.',
  'market-exhausted': 'The market ran out of cards.',
  forfeit: 'Everyone else left the game.',
  stalemate: 'No cards were left to draw and nobody could play.',
};

interface Props {
  room: RoomView;
  busy: boolean;
  reactions: Record<string, ReactionEvent>;
  lastReaction?: ReactionEvent;
  onReact: (id: string) => void;
  onRematch: () => void;
  onLobby: () => void;
  onLeave: () => void;
}

export function GameResult({ room, busy, reactions, lastReaction, onReact, onRematch, onLobby, onLeave }: Props) {
  const result = room.game!.result!;
  const isHost = room.hostId === room.youId;
  const name = (id: string) => room.names[id] ?? 'Former player';
  const youWon = result.winnerIds.includes(room.youId);
  const bots = new Set(room.seats.filter((x) => x.isBot).map((x) => x.id));

  return (
    <main className="mx-auto w-full max-w-xl px-4 py-6 sm:py-10">
      <Card className="text-center">
        <CardHeader className="items-center">
          <div className={`relative mb-2 grid size-20 place-items-center rounded-full bg-maroon text-cream shadow-lg ring-4 ring-gold/70 ${youWon ? 'animate-play' : ''}`} aria-hidden="true">
            <Trophy className="size-9" />
          </div>
          <p className="text-xs font-bold tracking-widest text-gold uppercase">Round {room.round} result</p>
          <CardTitle className="relative text-2xl sm:text-3xl">
            {result.winnerIds.map((id) => (
              <span key={id} className="relative mr-1.5 inline-block">
                <ReactionBubble reaction={reactions[id]} />
                {name(id)}
              </span>
            ))}
            {result.winnerIds.length > 1 ? 'share the win!' : 'wins!'}
          </CardTitle>
          {youWon ? <p className="font-semibold text-gold">That’s you. Well played!</p> : null}
          <CardDescription>{REASON[result.reason]}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 text-left">
          <ReactionAnnouncer reaction={lastReaction} nameOf={name} />
          <div className="flex justify-center"><MatchScore room={room} /></div>
          <RoundBreakdown result={result} names={room.names} youId={room.youId} bots={bots} />
          <p className="text-xs text-muted-foreground">{result.explanation}</p>

          <div className="flex flex-wrap items-center justify-center gap-2.5">
            {isHost ? (
              <>
                <Button size="lg" onClick={onRematch} loading={busy}><RotateCcw aria-hidden="true" /> Next round</Button>
                <Button variant="secondary" onClick={onLobby} disabled={busy}>New game</Button>
              </>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">Waiting for the host to start the next round…</p>
            )}
            <ReactionPicker onReact={onReact} />
            <Button variant="ghost" onClick={onLeave}><LogOut aria-hidden="true" /> Leave room</Button>
          </div>
          {isHost ? <p className="text-center text-xs text-muted-foreground">“Next round” keeps the win tally. “New game” returns to the lobby and resets it when you start again.</p> : null}
        </CardContent>
      </Card>
    </main>
  );
}
