import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GameState, RuleConfig } from '../lib/game/types.ts';
import { DEFAULT_RULES, normalizeRules } from '../lib/game/rules.ts';
import { secureRandomInt } from '../lib/game/deck.ts';
import { applyDraw, applyPlay, createGame, currentPlayerId, removePlayer } from '../lib/game/engine.ts';
import { chooseBotMove } from '../lib/game/bots.ts';
import type { BotLevel } from '../lib/game/bots.ts';
import { sanitizeGame } from '../lib/game/view.ts';
import type { Ack, DrawPayload, ErrorCode, PlayPayload, PublicSeat, ReactionEvent, RoomPhase, RoomView, ScoreRow, SessionInfo } from '../lib/socket/events.ts';
import { isReactionId } from '../lib/game/reactions.ts';
import { CODE_ALPHABET, CODE_LENGTH, cleanNickname, isMaxPlayers, isShape, isShortString, normalizeCode } from './validation.ts';

/*
 * ALL STATE LIVES IN THIS PROCESS'S MEMORY. There is no database. A restart, crash or redeploy erases
 * every room and game. This is intentional and documented in the README.
 */

export interface Seat {
  id: string;
  nickname: string;
  /** SHA-256 of the reconnect token. The raw token is only ever held by the player. */
  tokenHash: Buffer;
  socketId: string | null;
  disconnectedAt: number | null;
  recentActions: string[];
  lastReactionAt: number;
  /** Computer-controlled seat: no socket, no token, always "connected", never expires. */
  bot: boolean;
}

export interface Room {
  code: string;
  phase: RoomPhase;
  hostId: string;
  maxPlayers: 2 | 3 | 4;
  rules: RuleConfig;
  seats: Seat[];
  names: Record<string, string>;
  game: GameState | null;
  gamesPlayed: number;
  startIndex: number;
  /** Cumulative scores for this session; keyed by player id. Authoritative, server-side only. */
  scores: Record<string, { wins: number }>;
  botLevel: BotLevel;
  round: number;
  /** gamesPlayed value whose result has already been added to `scores` (prevents double counting). */
  scoredGame: number;
  createdAt: number;
  lastActivity: number;
}

export interface ManagerOptions {
  now?: () => number;
  graceMs?: number;
  idleMs?: number;
  maxRooms?: number;
  reactionCooldownMs?: number;
}

type Fail = { ok: false; code: ErrorCode; error: string };
type Done<T> = { ok: true } & T;
export type Res<T = object> = Done<T> | Fail;

const fail = (code: ErrorCode, error: string): Fail => ({ ok: false, code, error });
const hash = (token: string) => createHash('sha256').update(token).digest();

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly bySocket = new Map<string, { code: string; playerId: string }>();
  private readonly now: () => number;
  readonly graceMs: number;
  private readonly idleMs: number;
  private readonly maxRooms: number;
  private readonly reactionCooldownMs: number;
  private reactionSeq = 0;

  constructor(opts: ManagerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.graceMs = opts.graceMs ?? 60_000;
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.maxRooms = opts.maxRooms ?? 2000;
    this.reactionCooldownMs = opts.reactionCooldownMs ?? 1200;
  }

  /* ------------------------------------------------------------ internals */

  private touch(room: Room): void {
    room.lastActivity = this.now();
  }

  private newCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[secureRandomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a room code.');
  }

  private newSeat(nickname: string, socketId: string | null, bot = false): { seat: Seat; token: string } {
    const token = randomBytes(24).toString('base64url');
    const seat: Seat = {
      id: randomBytes(9).toString('base64url'),
      nickname,
      tokenHash: hash(token),
      socketId,
      disconnectedAt: socketId || bot ? null : this.now(),
      recentActions: [],
      lastReactionAt: 0,
      bot,
    };
    return { seat, token };
  }

  private bind(room: Room, seat: Seat, socketId: string): string | null {
    let replaced: string | null = null;
    if (seat.socketId && seat.socketId !== socketId) {
      replaced = seat.socketId;
      this.bySocket.delete(seat.socketId);
    }
    seat.socketId = socketId;
    seat.disconnectedAt = null;
    this.bySocket.set(socketId, { code: room.code, playerId: seat.id });
    return replaced;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  sessionOf(socketId: string): { code: string; playerId: string } | undefined {
    return this.bySocket.get(socketId);
  }

  private seatOf(room: Room, playerId: string): Seat | undefined {
    return room.seats.find((s) => s.id === playerId);
  }

  private ensureMember(code: string, playerId: string): Res<{ room: Room; seat: Seat }> {
    const room = this.rooms.get(code);
    if (!room) return fail('ROOM_NOT_FOUND', 'That room no longer exists.');
    const seat = this.seatOf(room, playerId);
    if (!seat) return fail('NOT_IN_ROOM', 'You are not in this room.');
    return { ok: true, room, seat };
  }

  private ensureHost(code: string, playerId: string): Res<{ room: Room; seat: Seat }> {
    const m = this.ensureMember(code, playerId);
    if (!m.ok) return m;
    if (m.room.hostId !== playerId) return fail('NOT_HOST', 'Only the host can do that.');
    return m;
  }

  private transferHostIfNeeded(room: Room): void {
    if (room.seats.some((s) => s.id === room.hostId)) return;
    // The host is always a human: prefer a connected one.
    const next = room.seats.find((s) => !s.bot && s.socketId) ?? room.seats.find((s) => !s.bot);
    if (next) room.hostId = next.id;
  }

  /** Credit the round's winner(s) in the match tally exactly once. */
  private settle(room: Room): void {
    const g = room.game;
    if (!g || g.status !== 'finished' || !g.result || room.scoredGame === room.gamesPlayed) return;
    room.scoredGame = room.gamesPlayed;
    for (const r of g.result.ranking) {
      const row = (room.scores[r.playerId] ??= { wins: 0 });
      if (r.winner) row.wins += 1;
    }
  }

  private dropSeat(room: Room, playerId: string): void {
    const seat = this.seatOf(room, playerId);
    if (!seat) return;
    if (seat.socketId) this.bySocket.delete(seat.socketId);
    room.seats = room.seats.filter((s) => s.id !== playerId);
    if (room.phase === 'playing' && room.game) {
      room.game = removePlayer(room.game, playerId);
      if (room.game.status === 'finished') {
        room.phase = 'finished';
        this.settle(room);
      }
    }
    this.transferHostIfNeeded(room);
  }

  /* ------------------------------------------------------------ lobby */

  createRoom(socketId: string, nicknameIn: unknown, maxPlayersIn: unknown, rulesIn: unknown): Res<{ room: Room; session: SessionInfo }> {
    const nickname = cleanNickname(nicknameIn);
    if (!nickname) return fail('INVALID_INPUT', 'Enter a nickname (1–16 characters).');
    if (!isMaxPlayers(maxPlayersIn)) return fail('INVALID_INPUT', 'Player limit must be 2, 3 or 4.');
    const norm = normalizeRules(rulesIn);
    if (!norm.ok) return fail('INVALID_INPUT', norm.error);
    if (this.rooms.size >= this.maxRooms) return fail('SERVER_BUSY', 'The server is full right now. Try again soon.');

    const { seat, token } = this.newSeat(nickname, socketId);
    const room: Room = {
      code: this.newCode(),
      phase: 'lobby',
      hostId: seat.id,
      maxPlayers: maxPlayersIn,
      rules: norm.rules,
      seats: [seat],
      names: { [seat.id]: nickname },
      game: null,
      gamesPlayed: 0,
      startIndex: 0,
      scores: {},
      botLevel: 'normal',
      round: 0,
      scoredGame: 0,
      createdAt: this.now(),
      lastActivity: this.now(),
    };
    this.rooms.set(room.code, room);
    this.bind(room, seat, socketId);
    return { ok: true, room, session: { code: room.code, playerId: seat.id, token } };
  }

  joinRoom(socketId: string, codeIn: unknown, nicknameIn: unknown): Res<{ room: Room; session: SessionInfo }> {
    const code = normalizeCode(codeIn);
    if (!code) return fail('INVALID_CODE', 'Room codes are 5 letters or numbers.');
    const nickname = cleanNickname(nicknameIn);
    if (!nickname) return fail('INVALID_INPUT', 'Enter a nickname (1–16 characters).');
    const room = this.rooms.get(code);
    if (!room) return fail('ROOM_NOT_FOUND', 'No room with that code. Check it and try again.');
    if (room.phase !== 'lobby') return fail('GAME_IN_PROGRESS', 'That game has already started.');
    if (room.seats.length >= room.maxPlayers) return fail('ROOM_FULL', 'That room is full.');
    if (room.seats.some((s) => s.nickname.toLowerCase() === nickname.toLowerCase())) {
      return fail('NAME_TAKEN', 'Someone in that room already uses that nickname.');
    }
    const { seat, token } = this.newSeat(nickname, socketId);
    room.seats.push(seat);
    room.names[seat.id] = nickname;
    this.bind(room, seat, socketId);
    this.touch(room);
    return { ok: true, room, session: { code, playerId: seat.id, token } };
  }

  reconnect(socketId: string, s: unknown): Res<{ room: Room; seat: Seat; replacedSocketId: string | null }> {
    const info = s as Partial<SessionInfo> | null;
    if (!info || typeof info !== 'object') return fail('INVALID_INPUT', 'Bad session.');
    const code = normalizeCode(info.code);
    if (!code || !isShortString(info.playerId, 40) || !isShortString(info.token, 100)) return fail('INVALID_INPUT', 'Bad session.');
    const room = this.rooms.get(code);
    if (!room) return fail('ROOM_NOT_FOUND', 'That room no longer exists.');
    const seat = this.seatOf(room, info.playerId);
    // Same message for "no such seat" and "wrong token" so seat ids cannot be probed.
    if (!seat || !timingSafeEqual(seat.tokenHash, hash(info.token))) return fail('BAD_TOKEN', 'Could not restore your seat.');
    const replacedSocketId = this.bind(room, seat, socketId);
    this.touch(room);
    return { ok: true, room, seat, replacedSocketId };
  }

  /** Mark a seat disconnected (grace period starts). Ignores sockets that were already replaced. */
  disconnect(socketId: string): { room: Room } | null {
    const ref = this.bySocket.get(socketId);
    if (!ref) return null;
    this.bySocket.delete(socketId);
    const room = this.rooms.get(ref.code);
    const seat = room && this.seatOf(room, ref.playerId);
    if (!room || !seat || seat.socketId !== socketId) return null;
    seat.socketId = null;
    seat.disconnectedAt = this.now();
    this.touch(room);
    return { room };
  }

  leave(code: string, playerId: string): Res<{ room: Room | null }> {
    const m = this.ensureMember(code, playerId);
    if (!m.ok) return m;
    this.dropSeat(m.room, playerId);
    this.touch(m.room);
    if (!m.room.seats.some((s) => !s.bot)) {
      this.rooms.delete(code);
      return { ok: true, room: null };
    }
    return { ok: true, room: m.room };
  }

  kick(code: string, hostId: string, targetId: unknown): Res<{ room: Room; kickedSocketId: string | null }> {
    const m = this.ensureHost(code, hostId);
    if (!m.ok) return m;
    if (m.room.phase !== 'lobby') return fail('WRONG_PHASE', 'You can only remove players in the lobby.');
    if (!isShortString(targetId, 40) || targetId === hostId) return fail('INVALID_INPUT', 'Cannot remove that player.');
    const target = this.seatOf(m.room, targetId);
    if (!target) return fail('NOT_IN_ROOM', 'That player is not in the room.');
    const kickedSocketId = target.socketId;
    this.dropSeat(m.room, targetId);
    this.touch(m.room);
    return { ok: true, room: m.room, kickedSocketId };
  }

  updateSettings(code: string, playerId: string, p: unknown): Res<{ room: Room }> {
    const m = this.ensureHost(code, playerId);
    if (!m.ok) return m;
    const { room } = m;
    if (room.phase !== 'lobby') return fail('WRONG_PHASE', 'Settings can only change in the lobby.');
    if (!p || typeof p !== 'object' || Array.isArray(p)) return fail('INVALID_INPUT', 'Bad settings.');
    const src = p as { maxPlayers?: unknown; rules?: unknown; botLevel?: unknown };
    let maxPlayers = room.maxPlayers;
    if (src.maxPlayers !== undefined) {
      if (!isMaxPlayers(src.maxPlayers)) return fail('INVALID_INPUT', 'Player limit must be 2, 3 or 4.');
      if (src.maxPlayers < room.seats.length) return fail('INVALID_INPUT', 'Remove players before lowering the limit.');
      maxPlayers = src.maxPlayers;
    }
    let rules = room.rules;
    if (src.rules !== undefined) {
      if (!src.rules || typeof src.rules !== 'object' || Array.isArray(src.rules)) return fail('INVALID_INPUT', 'Bad rules.');
      const norm = normalizeRules({ ...room.rules, ...(src.rules as object) });
      if (!norm.ok) return fail('INVALID_INPUT', norm.error);
      rules = norm.rules;
    }
    if (src.botLevel !== undefined) {
      if (src.botLevel !== 'easy' && src.botLevel !== 'normal') return fail('INVALID_INPUT', 'Unknown difficulty.');
      room.botLevel = src.botLevel;
    }
    room.maxPlayers = maxPlayers;
    room.rules = rules;
    this.touch(room);
    return { ok: true, room };
  }

  /* ------------------------------------------------------------ computer players */

  private addBotSeat(room: Room): Seat {
    let n = 1;
    while (room.seats.some((s) => s.nickname === `Computer ${n}`)) n++;
    const { seat } = this.newSeat(`Computer ${n}`, null, true);
    room.seats.push(seat);
    room.names[seat.id] = seat.nickname;
    return seat;
  }

  addBot(code: string, hostId: string): Res<{ room: Room }> {
    const m = this.ensureHost(code, hostId);
    if (!m.ok) return m;
    if (m.room.phase !== 'lobby') return fail('WRONG_PHASE', 'Computer players can only be added in the lobby.');
    if (m.room.seats.length >= m.room.maxPlayers) return fail('ROOM_FULL', 'The room is full. Raise the player limit first.');
    this.addBotSeat(m.room);
    this.touch(m.room);
    return { ok: true, room: m.room };
  }

  /** "Play with computer": a private room with 1–3 computer opponents, started immediately. */
  createVsComputer(socketId: string, nicknameIn: unknown, botsIn: unknown, levelIn: unknown, rulesIn: unknown): Res<{ room: Room; session: SessionInfo }> {
    if (botsIn !== 1 && botsIn !== 2 && botsIn !== 3) return fail('INVALID_INPUT', 'Choose 1, 2 or 3 computer opponents.');
    if (levelIn !== 'easy' && levelIn !== 'normal') return fail('INVALID_INPUT', 'Unknown difficulty.');
    const created = this.createRoom(socketId, nicknameIn, botsIn + 1, rulesIn);
    if (!created.ok) return created;
    created.room.botLevel = levelIn;
    for (let i = 0; i < botsIn; i++) this.addBotSeat(created.room);
    this.beginGame(created.room, true);
    return created;
  }

  /** True when it is a computer player's turn and at least one human is connected to watch (otherwise bots pause). */
  botTurnPending(code: string): boolean {
    const room = this.rooms.get(code);
    if (!room || room.phase !== 'playing' || !room.game || room.game.status !== 'playing') return false;
    if (!room.seats.some((s) => !s.bot && s.socketId)) return false;
    const cur = this.seatOf(room, currentPlayerId(room.game));
    return Boolean(cur?.bot);
  }

  /** Make the current computer player take its turn. Returns null if it is not a bot's turn. */
  botStep(code: string): Res<{ room: Room }> | null {
    if (!this.botTurnPending(code)) return null;
    const room = this.rooms.get(code) as Room;
    const game = room.game as GameState;
    const botId = currentPlayerId(game);
    const move = chooseBotMove(game, botId, room.botLevel);
    const r = move.type === 'play' ? applyPlay(game, botId, move.cardId, { calledShape: move.calledShape }) : applyDraw(game, botId);
    if (!r.ok) {
      // Cannot happen (bots only choose legal moves), but never leave the table stuck.
      const fallback = applyDraw(game, botId);
      if (!fallback.ok) return fail('ILLEGAL_MOVE', fallback.error);
      room.game = fallback.state;
    } else {
      room.game = r.state;
    }
    if (room.game.status === 'finished') {
      room.phase = 'finished';
      this.settle(room);
    }
    this.touch(room);
    return { ok: true, room };
  }

  /* ------------------------------------------------------------ game */

  private beginGame(room: Room, newSession: boolean): void {
    if (newSession) {
      // A genuinely new game: cumulative scores start from zero.
      room.scores = {};
      room.round = 0;
    }
    room.round += 1;
    const ids = room.seats.map((s) => s.id);
    room.game = createGame(ids, room.rules, { startIndex: room.startIndex % ids.length });
    room.phase = 'playing';
    room.gamesPlayed += 1;
    for (const s of room.seats) s.recentActions = [];
    this.touch(room);
  }

  startGame(code: string, playerId: string): Res<{ room: Room }> {
    const m = this.ensureHost(code, playerId);
    if (!m.ok) return m;
    if (m.room.phase !== 'lobby') return fail('WRONG_PHASE', 'The game has already started.');
    if (m.room.seats.length < 2) return fail('NOT_ENOUGH_PLAYERS', 'Wait for at least one more player.');
    m.room.startIndex = 0;
    this.beginGame(m.room, true);
    return { ok: true, room: m.room };
  }

  rematch(code: string, playerId: string): Res<{ room: Room }> {
    const m = this.ensureHost(code, playerId);
    if (!m.ok) return m;
    if (m.room.phase !== 'finished') return fail('WRONG_PHASE', 'Finish the current game first.');
    if (m.room.seats.length < 2) return fail('NOT_ENOUGH_PLAYERS', 'You need at least two players for a rematch.');
    m.room.startIndex = (m.room.startIndex + 1) % m.room.seats.length; // rotate who goes first
    this.beginGame(m.room, false); // next round: the win tally carries over
    return { ok: true, room: m.room };
  }

  /** Host returns everyone to the lobby (ends a game in progress or leaves the results screen). */
  endGame(code: string, playerId: string): Res<{ room: Room }> {
    const m = this.ensureHost(code, playerId);
    if (!m.ok) return m;
    if (m.room.phase === 'lobby') return fail('WRONG_PHASE', 'There is no game to end.');
    m.room.game = null;
    m.room.phase = 'lobby';
    this.touch(m.room);
    return { ok: true, room: m.room };
  }

  private gateAction(code: string, playerId: string, actionId: unknown, version: unknown): Res<{ room: Room; seat: Seat; game: GameState }> {
    const m = this.ensureMember(code, playerId);
    if (!m.ok) return m;
    const { room, seat } = m;
    if (room.phase !== 'playing' || !room.game) return fail('WRONG_PHASE', 'There is no game in progress.');
    if (!isShortString(actionId, 64) || !Number.isInteger(version)) return fail('INVALID_INPUT', 'Bad action.');
    if (seat.recentActions.includes(actionId as string)) return fail('DUPLICATE', 'That action was already applied.');
    if (version !== room.game.version) return fail('STALE', 'The table changed. Try again.');
    return { ok: true, room, seat, game: room.game };
  }

  private commit(room: Room, seat: Seat, actionId: string, state: GameState): void {
    seat.recentActions.push(actionId);
    if (seat.recentActions.length > 64) seat.recentActions.shift();
    room.game = state;
    if (state.status === 'finished') {
      room.phase = 'finished';
      this.settle(room);
    }
    this.touch(room);
  }

  play(code: string, playerId: string, p: Partial<PlayPayload> | null): Res<{ room: Room }> {
    const payload = p ?? {};
    const g = this.gateAction(code, playerId, payload.actionId, payload.version);
    if (!g.ok) return g;
    if (!isShortString(payload.cardId, 32)) return fail('INVALID_INPUT', 'Bad card.');
    if (payload.calledShape !== undefined && !isShape(payload.calledShape)) return fail('INVALID_INPUT', 'Bad shape.');
    if (payload.reverse !== undefined && typeof payload.reverse !== 'boolean') return fail('INVALID_INPUT', 'Bad option.');
    const r = applyPlay(g.game, playerId, payload.cardId, { calledShape: payload.calledShape, reverse: payload.reverse });
    if (!r.ok) return fail('ILLEGAL_MOVE', r.error);
    this.commit(g.room, g.seat, payload.actionId as string, r.state);
    return { ok: true, room: g.room };
  }

  draw(code: string, playerId: string, p: Partial<DrawPayload> | null): Res<{ room: Room }> {
    const payload = p ?? {};
    const g = this.gateAction(code, playerId, payload.actionId, payload.version);
    if (!g.ok) return g;
    const r = applyDraw(g.game, playerId);
    if (!r.ok) return fail('ILLEGAL_MOVE', r.error);
    this.commit(g.room, g.seat, payload.actionId as string, r.state);
    return { ok: true, room: g.room };
  }

  /** Emoji reaction from a seated player. Whitelisted ids only; per-player cooldown. Allowed in any phase. */
  react(code: string, playerId: string, reactionId: unknown): Res<{ room: Room; reaction: ReactionEvent }> {
    const m = this.ensureMember(code, playerId);
    if (!m.ok) return m;
    if (!isReactionId(reactionId)) return fail('INVALID_INPUT', 'Unknown reaction.');
    const t = this.now();
    if (t - m.seat.lastReactionAt < this.reactionCooldownMs) return fail('RATE_LIMITED', 'One reaction at a time.');
    m.seat.lastReactionAt = t;
    this.touch(m.room);
    this.reactionSeq += 1;
    return { ok: true, room: m.room, reaction: { id: `${t}-${this.reactionSeq}`, playerId, reactionId } };
  }

  /* ------------------------------------------------------------ views */

  /** Match tally: most round wins first (then name, for a stable order). */
  private standings(room: Room): ScoreRow[] {
    return Object.entries(room.scores)
      .map(([playerId, v]) => ({ playerId, wins: v.wins }))
      .sort((a, b) => b.wins - a.wins || (room.names[a.playerId] ?? '').localeCompare(room.names[b.playerId] ?? ''));
  }

  view(room: Room, playerId: string): RoomView {
    const seats: PublicSeat[] = room.seats.map((s) => ({
      id: s.id,
      nickname: s.nickname,
      connected: s.bot || s.socketId !== null,
      isHost: s.id === room.hostId,
      isBot: s.bot,
    }));
    return {
      code: room.code,
      phase: room.phase,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      rules: { ...room.rules },
      seats,
      names: { ...room.names },
      youId: playerId,
      game: room.game ? sanitizeGame(room.game, playerId) : null,
      gamesPlayed: room.gamesPlayed,
      round: room.round,
      scores: this.standings(room),
      botLevel: room.botLevel,
      graceMs: this.graceMs,
      serverNow: this.now(),
    };
  }

  /* ------------------------------------------------------------ maintenance */

  /**
   * Expire seats whose reconnect grace has run out and delete abandoned rooms.
   * Returns the rooms that changed (to rebroadcast) and the codes that were deleted.
   */
  sweep(): { changed: Room[]; deleted: string[]; expiredSocketless: Array<{ code: string; playerId: string }> } {
    const t = this.now();
    const changed = new Set<Room>();
    const deleted: string[] = [];
    const expired: Array<{ code: string; playerId: string }> = [];

    for (const room of [...this.rooms.values()]) {
      for (const seat of [...room.seats]) {
        if (seat.socketId === null && seat.disconnectedAt !== null && t - seat.disconnectedAt >= this.graceMs) {
          expired.push({ code: room.code, playerId: seat.id });
          this.dropSeat(room, seat.id);
          changed.add(room);
        }
      }
      const nobodyHere = room.seats.every((s) => s.socketId === null);
      const noHumans = !room.seats.some((x) => !x.bot);
      if (noHumans || (nobodyHere && t - room.lastActivity >= this.idleMs)) {
        this.rooms.delete(room.code);
        for (const s of room.seats) if (s.socketId) this.bySocket.delete(s.socketId);
        changed.delete(room);
        deleted.push(room.code);
      }
    }
    return { changed: [...changed], deleted, expiredSocketless: expired };
  }
}

export type { Ack };
export { DEFAULT_RULES };
