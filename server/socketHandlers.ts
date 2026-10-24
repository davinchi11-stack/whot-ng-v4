import type { Ack, ErrorCode } from '../lib/socket/events.ts';
import { RoomManager } from './roomManager.ts';
import type { Room } from './roomManager.ts';
import { TokenBucket } from './rateLimit.ts';

/** Minimal structural types so the handlers can be exercised without a real Socket.IO server. */
export interface SocketLike {
  id: string;
  on(event: string, handler: (...args: any[]) => void): unknown;
}
export interface IoLike {
  on(event: 'connection', handler: (socket: SocketLike) => void): unknown;
  to(socketId: string): { emit(event: string, ...args: any[]): unknown };
}

type AckFn = (r: Ack<any>) => void;
const bad = (code: ErrorCode, error: string): Ack => ({ ok: false, code, error });

export function broadcastRoom(io: IoLike, mgr: RoomManager, room: Room): void {
  for (const seat of room.seats) {
    if (seat.socketId) io.to(seat.socketId).emit('room:state', mgr.view(room, seat.id));
  }
}

export interface BotRunnerOptions {
  /** Injectable for tests. Defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** How long a computer player "thinks". */
  delayMs?: () => number;
}

/** Takes computer players' turns after a short, natural-feeling pause, one room at a time. */
export class BotRunner {
  private readonly pending = new Set<string>();
  private readonly io: IoLike;
  private readonly mgr: RoomManager;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly delayMs: () => number;

  constructor(io: IoLike, mgr: RoomManager, opts: BotRunnerOptions = {}) {
    this.io = io;
    this.mgr = mgr;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.delayMs = opts.delayMs ?? (() => 900 + Math.floor(Math.random() * 700));
  }

  /** Call after any change to a room. Schedules the next bot move if it is a computer player's turn. */
  poke(code: string): void {
    if (this.pending.has(code) || !this.mgr.botTurnPending(code)) return;
    this.pending.add(code);
    this.schedule(() => {
      this.pending.delete(code);
      const r = this.mgr.botStep(code);
      if (r && r.ok) {
        broadcastRoom(this.io, this.mgr, r.room);
        this.poke(code); // several computer players in a row
      }
    }, this.delayMs());
  }
}

export function registerHandlers(io: IoLike, mgr: RoomManager, opts: BotRunnerOptions = {}): BotRunner {
  const runner = new BotRunner(io, mgr, opts);
  const sync = (room: Room) => {
    broadcastRoom(io, mgr, room);
    runner.poke(room.code);
  };
  io.on('connection', (socket) => {
    const bucket = new TokenBucket(25, 10);

    const on = (event: string, fn: (payload: any, reply: (r: Ack<any>) => void) => void) => {
      socket.on(event, (...args: any[]) => {
        const last = args[args.length - 1];
        const ack: AckFn | undefined = typeof last === 'function' ? last : undefined;
        const payload = args.length > 0 && typeof args[0] !== 'function' ? args[0] : undefined;
        const reply = (r: Ack<any>) => {
          if (ack) ack(r);
        };
        if (!bucket.take()) return reply(bad('RATE_LIMITED', 'Slow down a little.'));
        try {
          fn(payload, reply);
        } catch (err) {
          console.error(`[whot] handler error in ${event}:`, err);
          reply(bad('INVALID_INPUT', 'Something went wrong. Please try again.'));
        }
      });
    };

    /** Identity comes from the server-side socket binding made at create/join/reconnect — never from the payload. */
    const session = () => mgr.sessionOf(socket.id);

    on('room:create', (p, reply) => {
      if (session()) return reply(bad('INVALID_INPUT', 'Leave your current room first.'));
      if (!p || typeof p !== 'object') return reply(bad('INVALID_INPUT', 'Bad request.'));
      const r = mgr.createRoom(socket.id, p.nickname, p.maxPlayers, p.rules);
      if (!r.ok) return reply(r);
      reply({ ok: true, session: r.session });
      sync(r.room);
    });

    on('room:playComputer', (p, reply) => {
      if (session()) return reply(bad('INVALID_INPUT', 'Leave your current room first.'));
      if (!p || typeof p !== 'object') return reply(bad('INVALID_INPUT', 'Bad request.'));
      const r = mgr.createVsComputer(socket.id, p.nickname, p.bots, p.level, p.rules);
      if (!r.ok) return reply(r);
      reply({ ok: true, session: r.session });
      sync(r.room);
    });

    on('room:addBot', (_p, reply) => {
      const s = session();
      if (!s) return reply(bad('NOT_IN_ROOM', 'You are not in a room.'));
      const r = mgr.addBot(s.code, s.playerId);
      reply(r.ok ? { ok: true } : r);
      if (r.ok) sync(r.room);
    });

    on('room:join', (p, reply) => {
      if (session()) return reply(bad('INVALID_INPUT', 'Leave your current room first.'));
      if (!p || typeof p !== 'object') return reply(bad('INVALID_INPUT', 'Bad request.'));
      const r = mgr.joinRoom(socket.id, p.code, p.nickname);
      if (!r.ok) return reply(r);
      reply({ ok: true, session: r.session });
      sync(r.room);
    });

    on('room:reconnect', (p, reply) => {
      const r = mgr.reconnect(socket.id, p);
      if (!r.ok) return reply(r);
      if (r.replacedSocketId) io.to(r.replacedSocketId).emit('session:replaced');
      reply({ ok: true });
      sync(r.room);
    });

    on('room:leave', (_p, reply) => {
      const s = session();
      if (!s) return reply({ ok: true });
      const r = mgr.leave(s.code, s.playerId);
      reply(r.ok ? { ok: true } : r);
      if (r.ok && r.room) sync(r.room);
    });

    on('room:updateSettings', (p, reply) => {
      const s = session();
      if (!s) return reply(bad('NOT_IN_ROOM', 'You are not in a room.'));
      const r = mgr.updateSettings(s.code, s.playerId, p);
      reply(r.ok ? { ok: true } : r);
      if (r.ok) sync(r.room);
    });

    on('room:kick', (p, reply) => {
      const s = session();
      if (!s) return reply(bad('NOT_IN_ROOM', 'You are not in a room.'));
      const r = mgr.kick(s.code, s.playerId, p?.playerId);
      reply(r.ok ? { ok: true } : r);
      if (r.ok) {
        if (r.kickedSocketId) io.to(r.kickedSocketId).emit('room:removed', 'kicked');
        sync(r.room);
      }
    });

    on('room:react', (p, reply) => {
      const s = session();
      if (!s) return reply(bad('NOT_IN_ROOM', 'You are not in a room.'));
      const r = mgr.react(s.code, s.playerId, p?.reactionId);
      reply(r.ok ? { ok: true } : r);
      if (r.ok) for (const seat of r.room.seats) if (seat.socketId) io.to(seat.socketId).emit('room:reaction', r.reaction);
    });

    const simple = (event: string, run: (code: string, playerId: string, payload: any) => ReturnType<RoomManager['startGame']>) =>
      on(event, (p, reply) => {
        const s = session();
        if (!s) return reply(bad('NOT_IN_ROOM', 'You are not in a room.'));
        const r = run(s.code, s.playerId, p);
        reply(r.ok ? { ok: true } : r);
        if (r.ok) sync(r.room);
      });

    simple('game:start', (code, id) => mgr.startGame(code, id));
    simple('game:play', (code, id, p) => mgr.play(code, id, p));
    simple('game:draw', (code, id, p) => mgr.draw(code, id, p));
    simple('game:end', (code, id) => mgr.endGame(code, id));
    simple('game:rematch', (code, id) => mgr.rematch(code, id));

    socket.on('disconnect', () => {
      const r = mgr.disconnect(socket.id);
      if (r) sync(r.room);
    });
  });
  return runner;
}

/** Periodic cleanup: expire reconnect grace periods and abandoned rooms. */
export function startSweeper(io: IoLike, mgr: RoomManager, everyMs = 5000, runner?: BotRunner): () => void {
  const timer = setInterval(() => {
    const { changed } = mgr.sweep();
    for (const room of changed) {
      broadcastRoom(io, mgr, room);
      runner?.poke(room.code);
    }
  }, everyMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
