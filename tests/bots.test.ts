import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBotMove } from '../lib/game/bots.ts';
import type { BotLevel } from '../lib/game/bots.ts';
import { applyDraw, applyPlay, createGame, currentPlayerId, playError } from '../lib/game/engine.ts';
import { RoomManager } from '../server/roomManager.ts';
import { c, must, rules, scenario, seeded, whot } from './helpers.ts';

function step(state: ReturnType<typeof createGame>, level: BotLevel, rng: (n: number) => number) {
  const id = currentPlayerId(state);
  const move = chooseBotMove(state, id, level, rng);
  if (move.type === 'play') {
    const card = state.players.find((p) => p.id === id)!.hand.find((h) => h.id === move.cardId)!;
    assert.ok(card, 'bot only plays a card it holds');
    assert.equal(playError(state, id, card), null, 'bot only makes legal plays');
    return must(applyPlay(state, id, move.cardId, { calledShape: move.calledShape }));
  }
  return must(applyDraw(state, id));
}

describe('computer player', () => {
  for (const level of ['easy', 'normal'] as const) {
    for (const n of [2, 3, 4]) {
      for (const mode of ['rollover', 'count'] as const) {
        test(`${level}, ${n} players, ${mode}: bots alone play legal moves to a finished game`, () => {
          const rng = seeded(40 + n);
          let s = createGame(Array.from({ length: n }, (_, i) => `b${i}`), rules({ mode }), { rng });
          let guard = 0;
          while (s.status === 'playing' && guard++ < 30000) {
            s = step(s, level, rng).state;
            const total = s.players.reduce((a, p) => a + p.hand.length, 0) + s.market.length + s.discard.length;
            assert.equal(total, 54, 'cards conserved');
          }
          assert.equal(s.status, 'finished');
          assert.ok(s.result!.winnerIds.length >= 1);
        });
      }
    }
  }

  test('normal defends a penalty whenever it can; easy sometimes does not', () => {
    const mk = () => scenario({ hands: [[c('circle', 2), c('circle', 4)], [c('cross', 2), c('cross', 9), c('cross', 8)]], top: c('circle', 7) });
    let g = must(applyPlay(mk(), 'p1', 'circle-2')).state;
    for (let seed = 1; seed <= 30; seed++) {
      const m = chooseBotMove(g, 'p2', 'normal', seeded(seed));
      assert.deepEqual(m, { type: 'play', cardId: 'cross-2' });
    }
    const easyDraws = Array.from({ length: 40 }, (_, i) => chooseBotMove(g, 'p2', 'easy', seeded(i + 1)).type).filter((t) => t === 'draw').length;
    assert.ok(easyDraws > 0 && easyDraws < 40, 'easy mixes defending and drawing');
    g = scenario({ hands: [[c('circle', 2), c('circle', 4)], [c('cross', 9), c('cross', 8)]], top: c('circle', 7) });
    g = must(applyPlay(g, 'p1', 'circle-2')).state;
    assert.deepEqual(chooseBotMove(g, 'p2', 'normal', seeded(1)), { type: 'draw' }, 'no defence available: pays the penalty');
  });

  test('normal sheds the highest legal card and keeps Whot for later', () => {
    const g = scenario({ hands: [[c('circle', 3), c('circle', 13), c('cross', 7), whot(1)], [c('square', 9), c('square', 8)]], top: c('circle', 7) });
    assert.deepEqual(chooseBotMove(g, 'p1', 'normal', seeded(1)), { type: 'play', cardId: 'circle-13' });
  });

  test('calls the shape it holds the most after a Whot, and goes out when it can', () => {
    const g = scenario({ hands: [[whot(1), c('star', 3), c('star', 4), c('cross', 7), c('square', 1)], [c('square', 9), c('square', 8)]], top: c('circle', 7), current: 0 });
    g.players[0].hand = [whot(1)];
    g.players[0].hand = [whot(1), c('star', 3), c('star', 4), c('cross', 11)];
    const m = chooseBotMove({ ...g, discard: [c('triangle', 12)] } as never, 'p1', 'normal', seeded(2));
    // only the Whot is playable on triangle 12; it must call star (2 cards) not cross (1)
    assert.deepEqual(m, { type: 'play', cardId: 'whot-1', calledShape: 'star' });
    const last = scenario({ hands: [[c('circle', 3)], [c('square', 9), c('square', 8)]], top: c('circle', 7) });
    assert.deepEqual(chooseBotMove(last, 'p1', 'normal', seeded(1)), { type: 'play', cardId: 'circle-3' });
  });

  test('draws when nothing is playable and never acts out of turn', () => {
    const g = scenario({ hands: [[c('cross', 3)], [c('square', 9)]], top: c('circle', 7) });
    assert.deepEqual(chooseBotMove(g, 'p1', 'normal', seeded(1)), { type: 'draw' });
    assert.deepEqual(chooseBotMove(g, 'p2', 'normal', seeded(1)), { type: 'draw' }, 'not its turn: no play');
  });

  test('its decision does not depend on opponents’ hidden cards or the market (only their counts)', () => {
    const base = () => scenario({ hands: [[c('circle', 3), c('circle', 13), c('cross', 7)], [c('square', 9), c('square', 8), c('star', 2)]], top: c('circle', 7) });
    const a = base();
    const b = base();
    b.players[1].hand = [c('triangle', 14), c('cross', 1), c('whot', 20 as never)].map((x, i) => ({ ...x, id: `z${i}` })) as never;
    b.market = [c('star', 7)];
    for (let seed = 1; seed <= 20; seed++) {
      assert.deepEqual(chooseBotMove(a, 'p1', 'normal', seeded(seed)), chooseBotMove(b, 'p1', 'normal', seeded(seed)));
    }
  });
});

describe('computer players in rooms', () => {
  const ok = <T extends { ok: boolean }>(r: T) => { assert.equal(r.ok, true, JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
  const failCode = (r: { ok: boolean }) => { assert.equal(r.ok, false); return (r as unknown as { code: string }).code; };
  let n = 0;
  const aid = () => `bot-a${++n}`;

  test('"play with computer" starts straight away with the requested opponents', () => {
    const mgr = new RoomManager();
    for (const bots of [1, 2, 3]) {
      const r = ok(mgr.createVsComputer('sock', 'Ada', bots, 'normal', { mode: 'count' }));
      assert.equal(r.room.phase, 'playing');
      assert.equal(r.room.seats.length, bots + 1);
      assert.equal(r.room.seats.filter((s) => s.bot).length, bots);
      assert.equal(r.room.hostId, r.session.playerId, 'the human is the host');
      assert.equal(r.room.rules.mode, 'count');
      const view = mgr.view(r.room, r.session.playerId);
      assert.ok(view.seats.filter((s) => s.isBot).every((s) => s.connected && /^Computer \d$/.test(s.nickname)));
      assert.equal(view.game!.you.hand.length, 5);
      mgr.leave(r.room.code, r.session.playerId);
    }
    assert.equal(failCode(mgr.createVsComputer('s', 'Ada', 0, 'normal', {})), 'INVALID_INPUT');
    assert.equal(failCode(mgr.createVsComputer('s', 'Ada', 4, 'normal', {})), 'INVALID_INPUT');
    assert.equal(failCode(mgr.createVsComputer('s', 'Ada', 2, 'genius', {})), 'INVALID_INPUT');
    assert.equal(failCode(mgr.createVsComputer('s', '', 2, 'easy', {})), 'INVALID_INPUT');
  });

  test('host can add computer players in the lobby (limits and permissions enforced)', () => {
    const mgr = new RoomManager();
    const host = ok(mgr.createRoom('s1', 'Ada', 3, {}));
    const guest = ok(mgr.joinRoom('s2', host.room.code, 'Bola'));
    assert.equal(failCode(mgr.addBot(host.room.code, guest.session.playerId)), 'NOT_HOST');
    ok(mgr.addBot(host.room.code, host.session.playerId));
    assert.equal(failCode(mgr.addBot(host.room.code, host.session.playerId)), 'ROOM_FULL');
    assert.equal(host.room.seats.map((s) => s.nickname).join(), 'Ada,Bola,Computer 1');
    ok(mgr.kick(host.room.code, host.session.playerId, host.room.seats[2].id));
    ok(mgr.addBot(host.room.code, host.session.playerId));
    assert.equal(host.room.seats[2].nickname, 'Computer 1', 'removed bot names are reused');
    ok(mgr.updateSettings(host.room.code, host.session.playerId, { botLevel: 'easy' }));
    assert.equal(host.room.botLevel, 'easy');
    assert.equal(failCode(mgr.updateSettings(host.room.code, host.session.playerId, { botLevel: 'x' })), 'INVALID_INPUT');
    ok(mgr.startGame(host.room.code, host.session.playerId));
    assert.equal(failCode(mgr.addBot(host.room.code, host.session.playerId)), 'WRONG_PHASE');
  });

  test('computers never become host, never expire, and the room closes when the last human leaves', () => {
    let now = 1_000;
    const mgr = new RoomManager({ now: () => now, graceMs: 1000, idleMs: 5000 });
    const host = ok(mgr.createRoom('s1', 'Ada', 4, {}));
    const guest = ok(mgr.joinRoom('s2', host.room.code, 'Bola'));
    ok(mgr.addBot(host.room.code, host.session.playerId));
    ok(mgr.leave(host.room.code, host.session.playerId));
    assert.equal(host.room.hostId, guest.session.playerId);
    now += 60_000;
    mgr.disconnect('s2');
    now += 1500;
    mgr.sweep();
    assert.equal(mgr.getRoom(host.room.code), undefined, 'no humans left: room is removed (bots do not keep it alive)');

    const solo = ok(mgr.createVsComputer('s9', 'Cy', 2, 'normal', {}));
    ok(mgr.leave(solo.room.code, solo.session.playerId));
    assert.equal(mgr.getRoom(solo.room.code), undefined);
  });

  test('bots take their turns through botStep and pause when no human is connected', () => {
    const mgr = new RoomManager();
    const r = ok(mgr.createVsComputer('s1', 'Ada', 2, 'normal', {}));
    const code = r.room.code;
    const human = r.session.playerId;
    assert.equal(mgr.botStep(code) === null, currentPlayerId(r.room.game!) === human, 'acts only on a computer’s turn');
    // drive to the human's turn
    let guard = 0;
    while (currentPlayerId(r.room.game!) !== human && guard++ < 10) ok(mgr.botStep(code)!);
    assert.equal(mgr.botStep(code), null, 'human to move: bots wait');
    mgr.disconnect('s1');
    ok(mgr.draw(code, human, { version: r.room.game!.version, actionId: aid() }) as never);
  });

  test('a full game of one human + bots finishes, scores the winner once, and supports a next round', () => {
    for (const mode of ['rollover', 'count'] as const) {
      const mgr = new RoomManager();
      const r = ok(mgr.createVsComputer('s1', 'Ada', 3, 'normal', { mode }));
      const human = r.session.playerId;
      let guard = 0;
      while (r.room.phase === 'playing' && guard++ < 20000) {
        if (currentPlayerId(r.room.game!) === human) {
          const v = mgr.view(r.room, human).game!;
          if (v.you.playableCardIds.length) {
            const card = v.you.hand.find((h) => h.id === v.you.playableCardIds[0])!;
            ok(mgr.play(r.room.code, human, { cardId: card.id, calledShape: 'circle', version: v.version, actionId: aid() }));
          } else ok(mgr.draw(r.room.code, human, { version: v.version, actionId: aid() }));
        } else ok(mgr.botStep(r.room.code)!);
      }
      assert.equal(r.room.phase, 'finished');
      const wins = mgr.view(r.room, human).scores.reduce((a, s) => a + s.wins, 0);
      assert.equal(wins, r.room.game!.result!.winnerIds.length, 'credited exactly once');
      ok(mgr.rematch(r.room.code, human));
      assert.equal(r.room.phase, 'playing');
      assert.equal(r.room.round, 2);
    }
  });
});
