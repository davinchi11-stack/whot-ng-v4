import type { Card, GameState, RealShape, Rng } from './types.ts';
import { SHAPES } from './types.ts';
import { currentPlayerId, playableCards } from './engine.ts';
import { cardPenaltyKind, cardValue } from './rules.ts';
import { secureRandomInt } from './deck.ts';

export type BotLevel = 'easy' | 'normal';
export type BotMove = { type: 'play'; cardId: string; calledShape?: RealShape } | { type: 'draw' };

/**
 * Picks a move for a computer player. It can ONLY choose from the engine's legal plays (or draw), so it can never
 * break a rule. It reads its own hand plus public information (opponents' card counts, the top card, the
 * penalty) and never looks at other hands or the market.
 */
export function chooseBotMove(state: GameState, botId: string, level: BotLevel, rng: Rng = secureRandomInt): BotMove {
  if (state.status !== 'playing' || currentPlayerId(state) !== botId) return { type: 'draw' };
  const options = playableCards(state, botId);
  if (options.length === 0) return { type: 'draw' };
  const me = state.players.find((p) => p.id === botId)!;

  if (level === 'easy') {
    // Casual: sometimes draws when it didn't have to, sometimes pays a penalty it could have defended.
    if (!state.penalty && rng(5) === 0) return { type: 'draw' };
    if (state.penalty && rng(10) < 4) return { type: 'draw' };
    const card = options[rng(options.length)];
    return play(card, me.hand, rng, false);
  }

  const opponentsMin = Math.min(...state.players.filter((p) => p.id !== botId).map((p) => p.hand.length));
  const threatened = opponentsMin <= 3;
  const finishing = me.hand.length === 1;

  const score = (card: Card): number => {
    if (finishing) return 1000; // any legal play empties the hand
    let s = cardValue(card, state.rules); // shed big cards first: they hurt most in the count
    const kind = cardPenaltyKind(card);
    if (card.shape === 'whot') s += me.hand.length <= 2 ? 0 : -14; // keep the flexible card unless it helps finish
    if (state.penalty) s += 50; // always defend if it can
    else if (kind) s += threatened ? 10 : 2; // attack when someone is close to going out
    if (card.shape !== 'whot') {
      if (card.number === 1) s += 5; // play again
      if (card.number === 14) s += state.rules.generalMarketPlaysAgain ? 4 : 1;
      if (card.number === 8 && state.rules.suspension8) s += threatened ? 4 : 1;
    }
    return s + rng(100) / 1000; // tiny random tie-break
  };

  let best = options[0];
  let bestScore = -Infinity;
  for (const c of options) {
    const sc = score(c);
    if (sc > bestScore) {
      best = c;
      bestScore = sc;
    }
  }
  return play(best, me.hand, rng, true);
}

function play(card: Card, hand: Card[], rng: Rng, smart: boolean): BotMove {
  if (card.shape !== 'whot') return { type: 'play', cardId: card.id };
  const rest = hand.filter((c) => c.id !== card.id && c.shape !== 'whot');
  const counts = new Map<RealShape, number>();
  for (const c of rest) counts.set(c.shape as RealShape, (counts.get(c.shape as RealShape) ?? 0) + 1);
  let candidates: RealShape[] = [...SHAPES];
  if (smart && counts.size > 0) {
    const max = Math.max(...counts.values());
    candidates = [...counts.entries()].filter(([, n]) => n === max).map(([s]) => s);
  }
  return { type: 'play', cardId: card.id, calledShape: candidates[rng(candidates.length)] };
}
