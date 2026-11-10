import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { MANUAL_LINEUPS_SOURCE_ID, sourceById, type LineupEntry } from '@ft/content';
import type { MissingXiItem } from '@ft/shared';
import { ContentService, LineupError } from '../src/contentService.js';
import { MemoryPersistence } from '../src/persistence.js';

/** A fictional line-up (made-up match and names). */
const entry = (over: Partial<LineupEntry> = {}): LineupEntry => ({
  match: 'Fictional Cup Final: Alder FC 2–1 Birch United',
  date: '2020-05-30',
  competition: 'Fictional Cup',
  team: 'Alder FC',
  formation: '4-3-3',
  sourceUrl: 'https://example.org/fictional-final',
  players: [
    { name: 'Goalie Gomez', position: 'GK', shirt: 1, aliases: [] },
    ...['Dan Def', 'Eli Back', 'Finn Wall', 'Gus Guard'].map((name, i) => ({
      name,
      position: 'DF' as const,
      shirt: i + 2,
      aliases: [],
    })),
    ...['Max Mid', 'Ned Pass', 'Oli Link'].map((name, i) => ({
      name,
      position: 'MF' as const,
      shirt: i + 6,
      aliases: [],
    })),
    ...['Pete Goal', 'Quin Shot', 'Rex Strike'].map((name, i) => ({
      name,
      position: 'FW' as const,
      shirt: i + 9,
      aliases: [],
    })),
  ],
  ...over,
});

const svc = async (db = new MemoryPersistence()) => {
  const s = new ContentService(db, pino({ level: 'silent' }), {
    strict: true,
    requireCommercialRights: false,
  });
  await s.init();
  return s;
};

afterEach(() => {
  const s = sourceById(MANUAL_LINEUPS_SOURCE_ID)!;
  s.licenseStatus = 'PENDING';
  s.allowedUses = [];
  s.licenseHistory = [];
});

describe('owner-entered line-ups (Missing XI)', () => {
  it('validates entries: 11 different names, one goalkeeper, formation adds up, https source, past date', async () => {
    const s = await svc();
    const bad: Array<[Partial<LineupEntry>, RegExp]> = [
      [{ players: entry().players.slice(0, 10) }, /11/],
      [{ formation: '4-4-3' }, /10 outfield/],
      [{ sourceUrl: 'http://example.org/x' }, /https/],
      [{ date: '2999-01-01' }, /future/],
      [{ players: entry().players.map((p) => ({ ...p, position: 'DF' as const })) }, /goalkeeper/],
      [{ players: entry().players.map((p, i) => (i === 3 ? { ...p, name: 'Dan Def' } : p)) }, /different/],
    ];
    for (const [over, msg] of bad) await expect(s.addLineup(entry(over), 'owner')).rejects.toThrow(msg);
  });

  it('creates Missing XI questions at once; blocked until the source license is recorded, then reviewed', async () => {
    const db = new MemoryPersistence();
    const s = await svc(db);
    const r = await s.addLineup(entry(), 'owner');
    expect(r.questions).toHaveLength(4);
    expect(r.questions.every((q) => q.status === 'BLOCKED_RIGHTS')).toBe(true);
    await s.setLicense(MANUAL_LINEUPS_SOURCE_ID, {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY'],
      by: 'owner',
      note: 'my own entries from official pages',
    });
    const qs = s.bank.all().filter((q) => q.template === 'ml.xi.kickoff');
    expect(qs).toHaveLength(4);
    expect(qs.every((q) => q.status === 'NEEDS_REVIEW')).toBe(true);
    for (const q of qs) {
      const item = q.item as MissingXiItem;
      expect(item.slots.filter((x) => x.player === null)).toHaveLength(1);
      expect(item.slots.find((x) => x.player === null)!.position).not.toBe('GK');
      expect(item.hints.join(' ')).not.toContain(item.missingAnswer);
    }
    await expect(s.addLineup(entry(), 'owner')).rejects.toBeInstanceOf(LineupError);
    // Survives a restart (stored as a snapshot).
    const again = await svc(db);
    expect(again.lineups()).toHaveLength(1);
    expect(again.lineups()[0]!.sourceUrl).toBe('https://example.org/fictional-final');
  });

  it('deleting a line-up retires its questions; it can then be entered again', async () => {
    const db = new MemoryPersistence();
    const s = await svc(db);
    const { id } = await s.addLineup(entry(), 'owner');
    expect((await s.deleteLineup(id, 'owner')).retired).toBe(4);
    expect(s.lineups()).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 5));
    expect(
      s.bank
        .all()
        .filter((q) => q.template === 'ml.xi.kickoff')
        .every((q) => q.status === 'RETIRED'),
    ).toBe(true);
    const r = await s.addLineup(entry(), 'owner');
    expect(r.questions).toHaveLength(4);
    expect(s.lineups()).toHaveLength(1);
    // After a restart: the re-entered version is live, the deleted one stays deleted.
    const again = await svc(db);
    expect(again.lineups()).toHaveLength(1);
    expect(
      again.bank.all().filter((q) => q.template === 'ml.xi.kickoff' && q.status === 'BLOCKED_RIGHTS'),
    ).toHaveLength(4);
  });
});
