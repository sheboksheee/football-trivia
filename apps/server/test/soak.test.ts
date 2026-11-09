import { describe, expect, it } from 'vitest';
import { createRng, Fraction, PLAYABLE_MODE_KEYS, type ModeKey } from '@ft/shared';
import {
  createRoom,
  DEFAULT_TIMING,
  engineFor,
  project,
  reduce,
  replay,
  type RoomEvent,
  type RoomState,
} from '@ft/game-rules';
import { runPipeline } from '@ft/content';

const bank = runPipeline().bank;

/** Random but plausible actions for every mode, so all engines are exercised through the room reducer. */
function randomActions(rng: () => number): Array<Record<string, unknown>> {
  const opt = () => `o${1 + Math.floor(rng() * 4)}`;
  return [
    { type: 'answer', choice: rng() < 0.5 ? 'HIGHER' : 'LOWER' },
    { type: 'answer', optionId: opt() },
    { type: 'answer', text: rng() < 0.5 ? 'Northbridge Athletic' : 'nobody' },
    { type: 'hint' },
    { type: 'risk', risk: ['SAFE', 'BOLD', 'ALL_IN'][Math.floor(rng() * 3)] },
    { type: 'pick', eventId: rng() < 0.5 ? 'e1' : 'e2' },
    { type: 'guess', text: rng() < 0.3 ? 'nobody' : 'Name' },
    { type: 'buzz' },
    { type: 'bid', amount: 1 + Math.floor(rng() * 4) },
    { type: 'drop' },
    { type: 'clueDone' },
  ];
}

describe('soak: full 12-mode Match Night with bots', () => {
  for (const seed of [1, 2, 3]) {
    it(`completes, replays identically and never leaks secrets to spectators (seed ${seed})`, () => {
      const rng = createRng(seed);
      const players = ['p1', 'p2', 'p3', 'p4'];
      const events: RoomEvent[] = [];
      const create: RoomEvent = {
        type: 'create',
        at: 0,
        roomId: 'r',
        code: 'SOAKAA',
        seed,
        timing: DEFAULT_TIMING,
        memberId: 'p1',
        name: 'P1',
      };
      events.push(create);
      let s: RoomState = createRoom(create);
      const push = (e: RoomEvent) => {
        try {
          s = reduce(s, e);
          events.push(e);
        } catch {
          /* rejected commands do not enter the log */
        }
      };
      let t = 0;
      for (const p of players.slice(1)) push({ type: 'join', at: t, memberId: p, name: p, role: 'PLAYER' });
      push({ type: 'join', at: t, memberId: 'j', name: 'Judge', role: 'JUDGE' });
      push({ type: 'join', at: t, memberId: 'spec', name: 'Spec', role: 'SPECTATOR' });
      const modes = PLAYABLE_MODE_KEYS as ModeKey[];
      push({
        type: 'cmd',
        at: t,
        actorId: 'p1',
        command: { type: 'room.configure', payload: { preset: 'CUSTOM', modes } },
      });
      for (const p of players)
        push({ type: 'cmd', at: t, actorId: p, command: { type: 'room.ready', payload: { ready: true } } });
      const used = new Set<string>();
      const content = modes.map((k) =>
        bank.draw(engineFor(k).contentKind, engineFor(k).itemsNeeded(players.length), rng, used),
      );
      push({
        type: 'start',
        at: t,
        actorId: 'p1',
        content,
        tiebreakContent: bank.draw('mcq', 5, rng, used) as never,
      });
      expect(s.status).toBe('IN_PROGRESS');
      let steps = 0;
      while (s.status !== 'COMPLETED' && steps++ < 20000) {
        t += 400 + Math.floor(rng() * 800);
        push({ type: 'tick', at: t });
        const actor = [...players, 'j'][Math.floor(rng() * 5)]!;
        const acts = randomActions(rng);
        if (actor === 'j') {
          const judgeActs = [
            { type: 'verdict', verdict: rng() < 0.5 ? 'CORRECT' : 'WRONG' },
            { type: 'tap' },
            { type: 'review', memberId: players[Math.floor(rng() * 4)], accept: rng() < 0.5 },
          ];
          push({
            type: 'cmd',
            at: t,
            actorId: 'j',
            command: { type: 'game.action', payload: { action: judgeActs[Math.floor(rng() * 3)]! } },
          });
        } else if (rng() < 0.03) {
          push({
            type: 'cmd',
            at: t,
            actorId: actor,
            command: {
              type: 'appeal.open',
              payload: { questionIndex: Math.floor(rng() * 5), reason: 'QUESTION_INCORRECT' },
            },
          });
        } else {
          push({
            type: 'cmd',
            at: t,
            actorId: actor,
            command: { type: 'game.action', payload: { action: acts[Math.floor(rng() * acts.length)]! } },
          });
        }
        const pending = s.appeals.find((a) => a.status === 'PENDING');
        if (pending)
          push({
            type: 'cmd',
            at: t,
            actorId: 'j',
            command: {
              type: 'appeal.resolve',
              payload: {
                appealId: pending.id,
                decision: rng() < 0.5 ? 'REJECT' : 'VOID',
                note: 'soak decision',
              },
            },
          });
        // Secrecy: while an Impostor round is live, the spectator projection never names the footballer.
        const run = s.matchNight?.run;
        if (run?.key === 'impostor' && run.state) {
          const st = run.state as { phase: string; r: number; items: Array<{ footballer: string }> };
          if (st.phase !== 'ROUND_REVEAL' && st.phase !== 'DONE') {
            expect(JSON.stringify(project(s, { memberId: null, role: 'SPECTATOR' }, t))).not.toContain(
              st.items[st.r]!.footballer,
            );
          }
        }
      }
      expect(s.status).toBe('COMPLETED');
      const mn = s.matchNight!;
      expect(mn.results.map((r) => r.key)).toEqual(modes);
      expect(mn.results.filter((r) => r.skipped)).toEqual([]);
      expect(mn.final!.champions.length).toBeGreaterThan(0);
      // Placement shares per mode always sum to 5+3+1+0 = 9.
      for (const r of mn.results) {
        expect(Fraction.sum(Object.values(r.placement).map((x) => Fraction.parse(x))).toString()).toBe('9');
      }
      expect(JSON.stringify(replay(events))).toBe(JSON.stringify(s));
    }, 60_000);
  }
});
