import { describe, expect, it } from 'vitest';
import {
  ClientCommand,
  createRng,
  generateInviteCode,
  INVITE_ALPHABET,
  isInviteCode,
  matchesAlias,
  MODES,
  MODE_KEYS,
  normalizeAnswer,
  PLAYABLE_MODE_KEYS,
  shuffle,
} from '../src/index.js';

describe('invite codes', () => {
  it('are 6 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const c = generateInviteCode();
      expect(isInviteCode(c)).toBe(true);
      expect(/[01OIL]/.test(c)).toBe(false);
    }
    expect(INVITE_ALPHABET.length).toBe(31);
  });
  it('have low collision rate (20k samples)', () => {
    const s = new Set<string>();
    for (let i = 0; i < 20000; i++) s.add(generateInviteCode());
    expect(s.size).toBeGreaterThan(19990);
  });
});

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = createRng(42);
    const b = createRng(42);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
    expect(shuffle([1, 2, 3, 4, 5], createRng(7))).toEqual(shuffle([1, 2, 3, 4, 5], createRng(7)));
  });
});

describe('answer normalization', () => {
  it('folds case, diacritics, punctuation', () => {
    expect(normalizeAnswer('  Ödegaard-Silva. ')).toBe('odegaard silva');
    expect(matchesAlias('jose  MOURINHO', ['José Mourinho'])).toBe(true);
    expect(matchesAlias('', ['x'])).toBe(false);
    expect(matchesAlias('Mourinh', ['José Mourinho'])).toBe(false);
  });
  it('folds Arabic variants', () => {
    expect(normalizeAnswer('أحمد')).toBe(normalizeAnswer('احمد'));
    expect(normalizeAnswer('مُحَمَّد')).toBe('محمد');
  });
});

describe('mode catalog', () => {
  it('has the 12 approved modes in GDD order', () => {
    expect(MODE_KEYS).toHaveLength(12);
    expect(MODE_KEYS.map((k) => MODES[k].number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
  it('Who Am I? is blocked pending rules; every PROVISIONAL mode lists its proposals', () => {
    expect(MODES.who_am_i.rulesStatus).toBe('BLOCKED');
    expect(PLAYABLE_MODE_KEYS).not.toContain('who_am_i');
    for (const k of MODE_KEYS) {
      const m = MODES[k];
      if (m.rulesStatus === 'PROVISIONAL') expect(m.proposed.length).toBeGreaterThan(0);
      if (m.rulesStatus === 'BLOCKED') expect(m.blockers.length).toBeGreaterThan(0);
    }
    expect(MODES.impostor.minPlayers).toBe(3);
  });
});

describe('protocol validation', () => {
  it('accepts valid commands and rejects malformed', () => {
    expect(ClientCommand.safeParse({ type: 'room.join', payload: { code: 'abcdef', displayName: 'Sam', role: 'PLAYER' } }).success).toBe(true);
    expect(ClientCommand.safeParse({ type: 'room.join', payload: { code: 'abc', displayName: 'Sam', role: 'PLAYER' } }).success).toBe(false);
    expect(ClientCommand.safeParse({ type: 'room.join', payload: { code: 'ABCDEF', displayName: '<script>', role: 'PLAYER' } }).success).toBe(false);
    expect(ClientCommand.safeParse({ type: 'room.join', payload: { code: 'ABCDEF', displayName: 'x', role: 'HOST' } }).success).toBe(false);
    expect(ClientCommand.safeParse({ type: 'nope', payload: {} }).success).toBe(false);
  });
});
