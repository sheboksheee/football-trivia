import { describe, expect, it } from 'vitest';
import {
  parseLineupText,
  formationPositions,
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
  it('Who Am I? runs on owner-delegated PROVISIONAL rules; every PROVISIONAL mode lists its proposals', () => {
    expect(MODES.who_am_i.rulesStatus).toBe('PROVISIONAL');
    expect(PLAYABLE_MODE_KEYS).toContain('who_am_i');
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
    expect(
      ClientCommand.safeParse({
        type: 'room.join',
        payload: { code: 'abcdef', displayName: 'Sam', role: 'PLAYER' },
      }).success,
    ).toBe(true);
    expect(
      ClientCommand.safeParse({
        type: 'room.join',
        payload: { code: 'abc', displayName: 'Sam', role: 'PLAYER' },
      }).success,
    ).toBe(false);
    expect(
      ClientCommand.safeParse({
        type: 'room.join',
        payload: { code: 'ABCDEF', displayName: '<script>', role: 'PLAYER' },
      }).success,
    ).toBe(false);
    expect(
      ClientCommand.safeParse({
        type: 'room.join',
        payload: { code: 'ABCDEF', displayName: 'x', role: 'HOST' },
      }).success,
    ).toBe(false);
    expect(ClientCommand.safeParse({ type: 'nope', payload: {} }).success).toBe(false);
  });
});

describe('typo-tolerant, bilingual answer matching', () => {
  it('accepts Arabic or English, with or without the article / FC, and common Arabic spelling variants', async () => {
    const { matchesAlias } = await import('../src/index.js');
    const liverpool = ['Liverpool FC', 'Liverpool', 'ليفربول'];
    for (const a of [
      'liverpool',
      'Liverpool F.C.',
      'ليفربول',
      'الليفربول',
      'Liverpol',
      'Livrpool',
      'ليفربوول',
      'ليفربل',
    ])
      expect(matchesAlias(a, liverpool)).toBe(true);
    expect(matchesAlias('إنتر', ['انتر'])).toBe(true);
    expect(matchesAlias('الأهلى', ['الاهلي'])).toBe(true);
    expect(matchesAlias('مدرسه', ['مدرسة'])).toBe(true);
  });
  it('rejects real differences, very short words with typos, and answers as close to a rival', async () => {
    const { matchesAlias, bestMatch } = await import('../src/index.js');
    expect(matchesAlias('Chelsea', ['Liverpool FC', 'ليفربول'])).toBe(false);
    expect(matchesAlias('PSV', ['PSG'])).toBe(false); // 3 letters: no typo allowed
    // "Bayer" (Leverkusen) is not "Bayern" when Bayern is a rival in the same question
    expect(
      matchesAlias(
        'Bayer',
        ['FC Bayern München', 'Bayern'],
        ['Bayer 04 Leverkusen', 'Bayer Leverkusen', 'Bayer'],
      ),
    ).toBe(false);
    expect(matchesAlias('Bayren', ['Bayern'], ['Bayer'])).toBe(true);
    // ambiguous between two list entries -> no match
    const entries = [{ n: 'Silva' }, { n: 'Silvo' }];
    expect(bestMatch('Silvu', entries, (e) => [e.n])).toBeNull();
    expect(bestMatch('Silva', entries, (e) => [e.n])).toEqual({ n: 'Silva' });
  });
});

describe('pasted line-up parser', () => {
  const list = [
    '23 Emiliano Martínez',
    '26 Nahuel Molina',
    '13 Cristian Romero',
    '19 Nicolás Otamendi',
    '3 Nicolás Tagliafico',
    '7 Rodrigo De Paul',
    '24 Enzo Fernández',
    '20 Alexis Mac Allister',
    '10 Lionel Messi (c)',
    '9 Julián Álvarez',
    '11 Ángel Di María',
  ].join('\n');
  it('assigns positions from the formation and keeps shirt numbers', () => {
    const r = parseLineupText(list, '4-4-2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.players[0]).toEqual({ name: 'Emiliano Martínez', position: 'GK', shirt: 23 });
    expect(r.players.map((p) => p.position).join('')).toBe('GKDFDFDFDFMFMFMFMFFWFW');
    expect(r.players[8]).toEqual({ name: 'Lionel Messi', position: 'MF', shirt: 10 });
  });
  it('accepts Arabic names, bullets, trailing numbers and explicit positions', () => {
    const ar = [
      '• حارس محمد الشناوي 1',
      'مدافع أحمد حجازي',
      ...Array.from({ length: 9 }, (_, i) => `لاعب رقم${i} ${i + 2}`),
    ].join('\n');
    const r = parseLineupText(ar, '4-3-3');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.players[0]).toEqual({ name: 'محمد الشناوي', position: 'GK', shirt: 1 });
    expect(r.players[1]).toEqual({ name: 'أحمد حجازي', position: 'DF', shirt: null });
    expect(r.players[10]!.position).toBe('FW');
  });
  it('rejects the wrong number of lines or a bad formation', () => {
    expect(parseLineupText('a\nb', '4-3-3')).toEqual({ ok: false, error: 'Paste exactly 11 lines (got 2)' });
    expect(parseLineupText(list, '4-4-3').ok).toBe(false);
    expect(formationPositions('3-4-2-1')).toEqual([
      'GK',
      'DF',
      'DF',
      'DF',
      'MF',
      'MF',
      'MF',
      'MF',
      'MF',
      'MF',
      'FW',
    ]);
  });
});
