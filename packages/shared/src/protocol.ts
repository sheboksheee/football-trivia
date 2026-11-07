import { z } from 'zod';
import { MODE_KEYS } from './modes.js';

/** Wire protocol between web client and authoritative server. All inbound messages are validated. */

export const RoomRole = z.enum(['PLAYER', 'JUDGE', 'SPECTATOR']);
export type RoomRole = z.infer<typeof RoomRole>;

export const Locale = z.enum(['en', 'ar']);
export type Locale = z.infer<typeof Locale>;

export const DisplayName = z
  .string()
  .trim()
  .min(1, 'Name required')
  .max(24, 'Max 24 characters')
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .refine((s) => !/[\u0000-\u001f<>]/.test(s), 'Invalid characters');

export const ModeKeySchema = z.enum(MODE_KEYS);

export const AppealReason = z.enum([
  'ANSWER_SHOULD_BE_ACCEPTED',
  'QUESTION_INCORRECT',
  'QUESTION_AMBIGUOUS',
  'TECHNICAL_ISSUE',
]);
export type AppealReason = z.infer<typeof AppealReason>;

export const AppealDecision = z.enum(['ACCEPT', 'REJECT', 'VOID']);
export type AppealDecision = z.infer<typeof AppealDecision>;

const cmd = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

export const ClientCommand = z.discriminatedUnion('type', [
  cmd('room.create', z.object({ displayName: DisplayName, locale: Locale.default('en') })),
  cmd(
    'room.join',
    z.object({ code: z.string().trim().toUpperCase().length(6), displayName: DisplayName, role: RoomRole }),
  ),
  cmd('session.resume', z.object({ code: z.string().length(6), resumeToken: z.string().min(16).max(128) })),
  cmd('room.leave', z.object({})),
  cmd('room.ready', z.object({ ready: z.boolean() })),
  cmd(
    'room.configure',
    z.object({
      preset: z.enum(['SINGLE', 'QUICK', 'CLASSIC', 'MARATHON', 'CUSTOM']),
      modes: z.array(ModeKeySchema).min(1).max(12),
      coHostId: z.string().max(64).nullable().optional(),
    }),
  ),
  cmd('room.readyCheck', z.object({})),
  cmd('room.start', z.object({})),
  cmd('room.pause', z.object({ emergency: z.boolean(), reason: z.string().trim().max(200).optional() })),
  cmd('room.resume', z.object({})),
  cmd('room.transferHost', z.object({ toMemberId: z.string().max(64) })),
  cmd('room.kick', z.object({ memberId: z.string().max(64), reason: z.string().trim().min(3).max(200) })),
  cmd('room.nextMode', z.object({})),
  cmd('game.action', z.object({ action: z.record(z.string(), z.unknown()) })),
  cmd(
    'appeal.open',
    z.object({
      questionIndex: z.number().int().min(0).max(1000),
      reason: AppealReason,
      note: z.string().max(280).optional(),
    }),
  ),
  cmd(
    'appeal.resolve',
    z.object({
      appealId: z.string().max(64),
      decision: AppealDecision,
      note: z.string().trim().min(3).max(500),
      detail: z.number().int().min(1).max(1000).optional(),
    }),
  ),
  cmd('ping', z.object({})),
]);
export type ClientCommand = z.infer<typeof ClientCommand>;
export type ClientCommandType = ClientCommand['type'];

/** Envelope: every command carries a client-generated idempotency key and optional expected room version. */
export const ClientEnvelope = z.object({
  id: z.string().min(8).max(64),
  expectedVersion: z.number().int().nonnegative().optional(),
  command: z.unknown(),
});
export type ClientEnvelope = z.infer<typeof ClientEnvelope>;

export type ErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'ROOM_FULL'
  | 'INVALID_STATE'
  | 'STALE_VERSION'
  | 'RATE_LIMITED'
  | 'RULE_VIOLATION'
  | 'DEADLINE_PASSED'
  | 'DUPLICATE'
  | 'CONFLICT_OF_INTEREST'
  | 'INTERNAL';

export interface AckMessage {
  t: 'ack';
  id: string;
  ok: boolean;
  error?: { code: ErrorCode; message: string };
  duplicate?: boolean;
}

export interface WelcomeMessage {
  t: 'welcome';
  memberId: string;
  roomCode: string;
  resumeToken: string;
}

export interface StateMessage<V = unknown> {
  t: 'state';
  serverNow: number;
  view: V;
}

export interface KickedMessage {
  t: 'kicked';
  reason: string;
}

export type ServerMessage =
  AckMessage | WelcomeMessage | StateMessage | KickedMessage | { t: 'pong'; serverNow: number };

export class GameError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}
