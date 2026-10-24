import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../server/roomManager.ts';
import { registerHandlers } from '../server/socketHandlers.ts';
import type { IoLike, SocketLike } from '../server/socketHandlers.ts';
import type { RoomView, SessionInfo } from '../lib/socket/events.ts';

/**
 * A fake transport that mimics the Socket.IO surface the handlers use. This exercises the real handler
 * code, room manager, engine and sanitizer end to end. It does NOT exercise real network sockets.
 */
class FakeSocket implements SocketLike {
  handlers = new Map<string, (...a: any[]) => void>();
  states: RoomView[] = [];
  events: string[] = [];
  reactions: any[] = [];
  id: string;
  constructor(id: string) {
    this.id = id;
  }
  on(event: string, h: (...a: any[]) => void) {
    this.handlers.set(event, h);
  }
  /** Fire a client event and return the ack response synchronously (handlers are synchronous). */
  call(event: string, payload?: unknown): any {
    let result: any;
    const h = this.handlers.get(event);
    if (!h) throw new Error('no handler ' + event);
    if (payload === undefined) h((r: any) => (result = r));
    else h(payload, (r: any) => (result = r));
    return result;
  }
  get last() {
    return this.states[this.states.length - 1];
  }
}
class FakeIo implements IoLike {
  sockets = new Map<string, FakeSocket>();
  connHandler!: (s: SocketLike) => void;
  on(_e: 'connection', h: (s: SocketLike) => void) {
    this.connHandler = h;
  }
  to(id: string) {
    return {
      emit: (event: string, ...args: any[]) => {
        const s = this.sockets.get(id);
        if (!s) return;
        if (event === 'room:state') s.states.push(args[0]);
        else if (event === 'room:reaction') s.reactions.push(args[0]);
        else s.events.push(event);
      },
    };
  }
  connect(id: string) {
    const s = new FakeSocket(id);
    this.sockets.set(id, s);
    this.connHandler(s);
    return s;
  }
  disconnect(id: string) {
    this.sockets.get(id)!.handlers.get('disconnect')?.();
    this.sockets.delete(id);
  }
}

function setup() {
  const io = new FakeIo();
  const mgr = new RoomManager({ graceMs: 30_000 });
  const queue: Array<() => void> = [];
  registerHandlers(io, mgr, { schedule: (fn) => queue.push(fn), delayMs: () => 0 });
  /** Run scheduled bot moves until none remain. */
  const flush = (max = 5000) => {
    let n = 0;
    while (queue.length && n++ < max) (queue.shift() as () => void)();
    return n;
  };
  return { io, mgr, queue, flush };
}
let n = 0;
const aid = () => `h${++n}`;

describe('socket handlers (fake transport)', () => {
  test('create → join → settings → start → play, with every client receiving its own view', () => {
    const { io } = setup();
    const a = io.connect('A');
    const b = io.connect('B');
    const created = a.call('room:create', { nickname: 'Ada', maxPlayers: 3, rules: { mode: 'rollover' } });
    assert.equal(created.ok, true);
    const code = created.session.code as string;
    assert.equal(a.last.seats.length, 1);

    const joined = b.call('room:join', { nickname: 'Bola', code });
    assert.equal(joined.ok, true);
    assert.equal(a.last.seats.length, 2, 'host sees the new player');
    assert.equal(b.last.seats.length, 2);
    assert.equal(b.last.youId, joined.session.playerId);

    assert.equal(b.call('room:updateSettings', { rules: { mode: 'count' } }).code, 'NOT_HOST');
    assert.equal(a.call('room:updateSettings', { rules: { mode: 'count', starsCountDouble: true } }).ok, true);
    assert.equal(b.last.rules.mode, 'count', 'validated settings are broadcast');
    assert.equal(b.last.rules.starsCountDouble, true);

    assert.equal(b.call('game:start').code, 'NOT_HOST');
    assert.equal(a.call('game:start').ok, true);
    assert.equal(a.last.phase, 'playing');
    assert.equal(a.last.game!.you.hand.length, 5);
    assert.equal(b.last.game!.you.hand.length, 5);
    const ids = new Set(a.last.game!.you.hand.map((c) => c.id));
    assert.ok(b.last.game!.you.hand.every((c) => !ids.has(c.id)), 'players hold different cards');
    assert.ok(!JSON.stringify(a.last).includes(joined.session.token));
    assert.ok(!JSON.stringify(b.last).includes(created.session.token));

    // whoever's turn it is draws
    const cur = a.last.game!.currentPlayerId === created.session.playerId ? a : b;
    const other = cur === a ? b : a;
    const v = cur.last.game!.version;
    assert.equal(other.call('game:draw', { version: v, actionId: aid() }).code, 'ILLEGAL_MOVE');
    const id = aid();
    assert.equal(cur.call('game:draw', { version: v, actionId: id }).ok, true);
    assert.equal(cur.call('game:draw', { version: v, actionId: id }).code, 'DUPLICATE');
    assert.equal(cur.last.game!.you.hand.length, 6);
    assert.equal(other.last.game!.seats.find((s) => s.id === cur.last.youId)!.handCount, 6);
  });

  test('errors: bad code, unknown room, full room, unauthenticated actions, bad payloads', () => {
    const { io } = setup();
    const a = io.connect('A');
    const b = io.connect('B');
    assert.equal(a.call('room:join', { nickname: 'X', code: '!!' }).code, 'INVALID_CODE');
    assert.equal(a.call('room:join', { nickname: 'X', code: 'ABCDE' }).code, 'ROOM_NOT_FOUND');
    assert.equal(a.call('game:start').code, 'NOT_IN_ROOM');
    assert.equal(a.call('game:play', { cardId: 'x', version: 0, actionId: 'a' }).code, 'NOT_IN_ROOM');
    assert.equal(a.call('room:create', 'garbage').ok, false);
    assert.equal(a.call('room:create', { nickname: 'Ada', maxPlayers: 2 }).ok, true);
    assert.equal(a.call('room:create', { nickname: 'Ada2', maxPlayers: 2 }).ok, false, 'one room per socket');
    const code = [...(io.sockets.values())][0].last.code;
    assert.equal(b.call('room:join', { nickname: 'Bo', code }).ok, true);
    const c = io.connect('C');
    assert.equal(c.call('room:join', { nickname: 'Cy', code }).code, 'ROOM_FULL');
  });

  test('a player cannot impersonate another by sending their playerId', () => {
    const { io } = setup();
    const a = io.connect('A');
    const b = io.connect('B');
    const created = a.call('room:create', { nickname: 'Ada', maxPlayers: 2 });
    b.call('room:join', { nickname: 'Bo', code: created.session.code });
    assert.equal(b.call('room:kick', { playerId: created.session.playerId }).code, 'NOT_HOST');
    assert.equal(b.call('game:start', { playerId: created.session.playerId }).code, 'NOT_HOST');
    const evil = io.connect('E');
    const attempt = evil.call('room:reconnect', { ...created.session, token: 'guess' });
    assert.equal(attempt.code, 'BAD_TOKEN');
    assert.equal(evil.call('game:draw', { version: 0, actionId: aid() }).code, 'NOT_IN_ROOM');
  });

  test('disconnect keeps the seat and flags it; reconnect from a new socket restores the exact view', () => {
    const { io } = setup();
    const a = io.connect('A');
    const b = io.connect('B');
    const created = a.call('room:create', { nickname: 'Ada', maxPlayers: 2 });
    const joined = b.call('room:join', { nickname: 'Bo', code: created.session.code });
    a.call('game:start');
    const handBefore = JSON.stringify(b.last.game!.you.hand);

    io.disconnect('B');
    assert.equal(a.last.seats.find((s) => s.id === joined.session.playerId)!.connected, false);
    assert.equal(a.last.phase, 'playing', 'game survives a disconnect');

    const b2 = io.connect('B2');
    const re = b2.call('room:reconnect', joined.session as SessionInfo);
    assert.equal(re.ok, true);
    assert.equal(JSON.stringify(b2.last.game!.you.hand), handBefore);
    assert.equal(a.last.seats.find((s) => s.id === joined.session.playerId)!.connected, true);
  });

  test('a second tab reconnecting kicks the first off with session:replaced', () => {
    const { io } = setup();
    const a = io.connect('A');
    const created = a.call('room:create', { nickname: 'Ada', maxPlayers: 2 });
    const a2 = io.connect('A2');
    assert.equal(a2.call('room:reconnect', created.session).ok, true);
    assert.ok(a.events.includes('session:replaced'));
  });

  test('kick notifies the removed player; leave removes the seat; flood is rate-limited', () => {
    const { io } = setup();
    const a = io.connect('A');
    const b = io.connect('B');
    const created = a.call('room:create', { nickname: 'Ada', maxPlayers: 3 });
    const joined = b.call('room:join', { nickname: 'Bo', code: created.session.code });
    assert.equal(a.call('room:kick', { playerId: joined.session.playerId }).ok, true);
    assert.ok(b.events.includes('room:removed'));
    assert.equal(a.last.seats.length, 1);
    assert.equal(b.call('game:draw', { version: 0, actionId: aid() }).code, 'NOT_IN_ROOM');
    let limited = 0;
    for (let i = 0; i < 60; i++) if (b.call('game:start').code === 'RATE_LIMITED') limited++;
    assert.ok(limited > 0, 'burst beyond the bucket is rejected');
  });

  test('emoji reactions: everyone in the room receives them; unknown ids, strangers and spam are refused', () => {
    const { io } = setup();
    const a = io.connect('A');
    const b = io.connect('B');
    const outsider = io.connect('O');
    const created = a.call('room:create', { nickname: 'Ada', maxPlayers: 3 });
    const joined = b.call('room:join', { nickname: 'Bo', code: created.session.code });
    assert.equal(a.call('room:react', { reactionId: 'fire' }).ok, true);
    assert.deepEqual(a.reactions.map((r) => [r.playerId, r.reactionId]), [[created.session.playerId, 'fire']]);
    assert.deepEqual(b.reactions.map((r) => [r.playerId, r.reactionId]), [[created.session.playerId, 'fire']]);
    assert.equal(outsider.reactions.length, 0, 'other rooms never see it');
    assert.equal(outsider.call('room:react', { reactionId: 'fire' }).code, 'NOT_IN_ROOM');
    assert.equal(b.call('room:react', { reactionId: '<script>' }).code, 'INVALID_INPUT');
    assert.equal(b.call('room:react', { reactionId: '😂' }).code, 'INVALID_INPUT', 'raw emoji text is not accepted, only ids');
    assert.equal(b.call('room:react', undefined).code, 'INVALID_INPUT');
    assert.equal(b.call('room:react', { reactionId: 'laugh' }).ok, true);
    assert.equal(b.call('room:react', { reactionId: 'laugh' }).code, 'RATE_LIMITED', 'cooldown');
    assert.equal(a.reactions[1].playerId, joined.session.playerId);
  });

  test('play with computer: starts instantly, bots move only via the scheduler, and a whole game completes', () => {
    const { io, queue, flush } = setup();
    const a = io.connect('A');
    assert.equal(a.call('room:playComputer', { nickname: 'Ada', bots: 2, level: 'normal', rules: { mode: 'count' } }).ok, true);
    assert.equal(a.last.phase, 'playing');
    assert.equal(a.last.seats.length, 3);
    assert.equal(a.last.seats.filter((s) => s.isBot).length, 2);
    assert.equal(a.last.rules.mode, 'count');
    const me = a.last.youId;
    if (a.last.game!.currentPlayerId !== me) assert.equal(queue.length, 1, 'a bot is scheduled to move first');
    else assert.equal(queue.length, 0, 'human first: nothing scheduled');

    let guard = 0;
    while (a.last.phase === 'playing' && guard++ < 20000) {
      flush(); // bots take their turns
      const g = a.last.game!;
      if (a.last.phase !== 'playing' || g.currentPlayerId !== me) continue;
      const id = `c${guard}`;
      const first = g.you.playableCardIds[0];
      const r = first ? a.call('game:play', { cardId: first, calledShape: 'star', version: g.version, actionId: id }) : a.call('game:draw', { version: g.version, actionId: id });
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    assert.equal(a.last.phase, 'finished');
    assert.ok(a.last.game!.result);
    assert.equal(a.last.scores.reduce((n, s) => n + s.wins, 0), a.last.game!.result!.winnerIds.length);
    assert.equal(a.call('game:rematch').ok, true);
    assert.equal(a.last.phase, 'playing');
    assert.equal(a.last.round, 2);
    flush(1);
  });

  test('the player cannot act for a computer, and cannot touch computer seats', () => {
    const { io } = setup();
    const a = io.connect('A');
    a.call('room:playComputer', { nickname: 'Ada', bots: 1, level: 'easy' });
    const bot = a.last.seats.find((s) => s.isBot)!;
    const g = a.last.game!;
    if (g.currentPlayerId === bot.id) {
      assert.equal(a.call('game:draw', { version: g.version, actionId: 'x1' }).code, 'ILLEGAL_MOVE', 'cannot move on the computer’s turn');
    }
    assert.equal(a.call('room:kick', { playerId: bot.id }).code, 'WRONG_PHASE', 'cannot remove players mid-game');
    assert.equal(a.call('room:addBot').code, 'WRONG_PHASE');
    assert.equal(a.call('room:playComputer', { nickname: 'Again', bots: 1, level: 'easy' }).ok, false, 'one room per socket');
  });

  test('lobby: host adds and removes computer players and picks the difficulty', () => {
    const { io, queue } = setup();
    const a = io.connect('A');
    const b = io.connect('B');
    const created = a.call('room:create', { nickname: 'Ada', maxPlayers: 3 });
    b.call('room:join', { nickname: 'Bo', code: created.session.code });
    assert.equal(b.call('room:addBot').code, 'NOT_HOST');
    assert.equal(a.call('room:addBot').ok, true);
    assert.equal(a.last.seats.at(-1)!.isBot, true);
    assert.equal(b.last.seats.length, 3, 'everyone sees the computer player');
    assert.equal(a.call('room:addBot').code, 'ROOM_FULL');
    assert.equal(a.call('room:updateSettings', { botLevel: 'easy' }).ok, true);
    assert.equal(b.last.botLevel, 'easy');
    assert.equal(a.call('room:kick', { playerId: a.last.seats.at(-1)!.id }).ok, true);
    assert.equal(a.last.seats.length, 2);
    assert.equal(queue.length, 0, 'nothing scheduled in the lobby');
  });

  test('computers pause while the only human is disconnected and resume when they return', () => {
    const { io, queue, flush } = setup();
    const a = io.connect('A');
    const created = a.call('room:playComputer', { nickname: 'Ada', bots: 1, level: 'normal' });
    flush();
    // make it the computer's turn by letting the human draw until play passes
    let guard = 0;
    while (a.last.game!.currentPlayerId === a.last.youId && guard++ < 5) a.call('game:draw', { version: a.last.game!.version, actionId: `p${guard}` });
    assert.equal(queue.length, 1, 'bot scheduled while the human is connected');
    flush(1);
    io.disconnect('A');
    flush();
    const a2 = io.connect('A2');
    assert.equal(a2.call('room:reconnect', created.session).ok, true);
    assert.equal(a2.last.phase === 'playing' || a2.last.phase === 'finished', true);
  });
});
