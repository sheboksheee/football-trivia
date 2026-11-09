/**
 * Wikidata (CC0 1.0) adapter: club careers of well-known footballers.
 *
 * Verified 2026-11-09:
 *  - Licence: structured data in the main namespace is CC0 1.0 (wikidata.org/wiki/Wikidata:Licensing).
 *  - Query service https://query.wikidata.org/sparql (JSON results), search API
 *    https://www.wikidata.org/w/api.php?action=wbsearchentities. A descriptive User-Agent is required
 *    by the Wikimedia User-Agent policy; heavy whole-graph queries time out (HTTP 504), so we query
 *    one club at a time.
 *  - Properties: P54 member of sports team (qualifiers P580 start, P582 end), P106 occupation,
 *    Q937857 association football player, Q476028 association football club, P1532 country for sport.
 *
 * Flow: football-data.org club name -> search -> validated club item -> famous players of that club.
 * Every response is an immutable RawSnapshot. Club resolution is derived (never hand-mapped), and an
 * ambiguous resolution drops the club. Everything generated here still needs human review.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createRng, normalizeAnswer, shuffle } from '@ft/shared';
import type { Candidate } from '../generators/index.js';
import { snapshot } from '../fixture.js';
import type { Entity, Fact, GateResult, RawSnapshot } from '../model.js';
import { WIKIDATA_SOURCE_ID } from '../sources.js';
import { CLUB_AR, COMPETITION_AR } from './footballDataArabic.js';
import type { FetchLike } from './footballData.js';

export const WD_SPARQL_URL = 'https://query.wikidata.org/sparql';
export const WD_API_URL = 'https://www.wikidata.org/w/api.php';
/** Wikimedia policy: identify the tool and a contact page. Never a personal e-mail address. */
export const WD_USER_AGENT = 'FootballTrivia/0.1 (https://github.com/sheboksheee/football-trivia)';
/** Players below this many Wikipedia sitelinks are not fetched (keeps questions about known names). */
export const WD_MIN_SITELINKS = 30;
/** Club items checked per SPARQL validation query. */
export const WD_VALIDATE_BATCH = 100;

const QID = /^Q\d+$/;

export interface WdClientOptions {
  fetch?: FetchLike;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
}

export type WdResult =
  | { ok: true; snapshot: RawSnapshot }
  | { ok: false; status: number; reason: 'NETWORK' | 'RATE_LIMITED' | 'ERROR'; detail?: string };

export class WikidataClient {
  private last = 0;
  private readonly f: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly calls: string[] = [];

  constructor(private readonly o: WdClientOptions = {}) {
    this.f = o.fetch ?? ((url, init) => fetch(url, init) as never);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  private async get(url: string): Promise<{ ok: true; body: unknown } | Exclude<WdResult, { ok: true }>> {
    const retries = this.o.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + (this.o.minIntervalMs ?? 1000) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      this.calls.push(url);
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.f(url, {
          headers: {
            accept: 'application/sparql-results+json, application/json',
            'user-agent': WD_USER_AGENT,
          },
        });
      } catch (e) {
        return {
          ok: false,
          status: 0,
          reason: 'NETWORK',
          detail: e instanceof Error ? e.message : 'fetch failed',
        };
      }
      if (res.status === 200) {
        try {
          return { ok: true, body: await res.json() };
        } catch {
          return { ok: false, status: 200, reason: 'ERROR', detail: 'invalid JSON' };
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const after = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 5000 * (attempt + 1));
        continue;
      }
      return { ok: false, status: res.status, reason: res.status === 429 ? 'RATE_LIMITED' : 'ERROR' };
    }
  }

  /** Club search for one football-data.org team (raw results are kept as evidence). */
  async searchClub(team: WdTeamRef, retrievedAt: string): Promise<WdResult> {
    const q = new URLSearchParams({
      action: 'wbsearchentities',
      search: team.name,
      language: 'en',
      type: 'item',
      limit: '5',
      format: 'json',
    });
    const r = await this.get(`${WD_API_URL}?${q}`);
    if (!r.ok) return r;
    const parsed = SearchResp.safeParse(r.body);
    if (!parsed.success)
      return { ok: false, status: 200, reason: 'ERROR', detail: 'unexpected search payload' };
    const payload = {
      team,
      results: parsed.data.search.map((x) => ({
        id: x.id,
        label: x.label ?? '',
        description: x.description ?? '',
      })),
    };
    return {
      ok: true,
      snapshot: snapshot(WIKIDATA_SOURCE_ID, 'wd_search', `fd_${team.fdId}`, payload, retrievedAt),
    };
  }

  /** Which of these items are association football clubs, with English/Arabic labels. */
  async validateClubs(ids: string[], retrievedAt: string): Promise<WdResult> {
    const clean = [...new Set(ids.filter((x) => QID.test(x)))].sort();
    const query = `SELECT ?c ?en ?ar ?sl WHERE { VALUES ?c { ${clean.map((x) => `wd:${x}`).join(' ')} }
  ?c wdt:P31/wdt:P279* wd:Q476028 ; wikibase:sitelinks ?sl .
  OPTIONAL { ?c rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?c rdfs:label ?ar FILTER(LANG(?ar) = "ar") } }`;
    const r = await this.sparql(query);
    if (!r.ok) return r;
    const key = createHash('sha256').update(clean.join(',')).digest('hex').slice(0, 12);
    return {
      ok: true,
      snapshot: snapshot(WIKIDATA_SOURCE_ID, 'wd_clubs', key, { ids: clean, rows: r.rows }, retrievedAt),
    };
  }

  /** Well-known footballers with a P54 membership of `club`. */
  async clubPlayers(club: string, retrievedAt: string): Promise<WdResult> {
    if (!QID.test(club)) return { ok: false, status: 0, reason: 'ERROR', detail: 'bad id' };
    const query = `SELECT ?p ?sl ?from ?to ?en ?ar ?nat ?natAr WHERE {
  ?p p:P54 ?st . ?st ps:P54 wd:${club} .
  ?p wdt:P106 wd:Q937857 ; wikibase:sitelinks ?sl . FILTER(?sl >= ${WD_MIN_SITELINKS})
  OPTIONAL { ?st pq:P580 ?from } OPTIONAL { ?st pq:P582 ?to }
  OPTIONAL { ?p rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?p rdfs:label ?ar FILTER(LANG(?ar) = "ar") }
  OPTIONAL { ?p wdt:P1532 ?n . ?n rdfs:label ?nat FILTER(LANG(?nat) = "en") .
             OPTIONAL { ?n rdfs:label ?natAr FILTER(LANG(?natAr) = "ar") } }
} ORDER BY DESC(?sl)`;
    const r = await this.sparql(query);
    if (!r.ok) return r;
    return {
      ok: true,
      snapshot: snapshot(WIKIDATA_SOURCE_ID, 'wd_club_players', club, { club, rows: r.rows }, retrievedAt),
    };
  }

  private async sparql(query: string) {
    const r = await this.get(`${WD_SPARQL_URL}?${new URLSearchParams({ query, format: 'json' })}`);
    if (!r.ok) return r;
    const parsed = SparqlResp.safeParse(r.body);
    if (!parsed.success)
      return {
        ok: false as const,
        status: 200,
        reason: 'ERROR' as const,
        detail: 'unexpected SPARQL payload',
      };
    // Flatten bindings to {var: value}; entity URIs become bare Q-ids.
    const rows = parsed.data.results.bindings.map((b) =>
      Object.fromEntries(
        Object.entries(b).map(([k, v]) => [k, v.value.replace(/^http:\/\/www\.wikidata\.org\/entity\//, '')]),
      ),
    );
    return { ok: true as const, rows };
  }
}

const SearchResp = z.object({
  search: z.array(
    z
      .object({ id: z.string(), label: z.string().nullish(), description: z.string().nullish() })
      .passthrough(),
  ),
});
const SparqlResp = z.object({
  results: z.object({
    bindings: z.array(z.record(z.string(), z.object({ value: z.string() }).passthrough())),
  }),
});

export interface WdTeamRef {
  fdId: number;
  name: string;
  shortName: string | null;
  competitionCode: string | null;
}

export interface WdIngestReport {
  snapshots: RawSnapshot[];
  calls: number;
  skipped: Array<{ what: string; reason: string }>;
}

/**
 * Fetches what is missing: one search per club, one validation batch, one player list per club.
 * Stops at the first network failure (the environment probably blocks the host).
 */
export async function ingestWikidata(
  client: WikidataClient,
  o: {
    teams: WdTeamRef[];
    have: Map<string, RawSnapshot>;
    refresh?: boolean;
    now?: () => string;
    onSnapshot?: (s: RawSnapshot) => Promise<void> | void;
    onProgress?: (msg: string) => void;
  },
): Promise<WdIngestReport> {
  const at = o.now ?? (() => new Date().toISOString());
  const report: WdIngestReport = { snapshots: [], calls: 0, skipped: [] };
  const keep = async (s: RawSnapshot) => {
    report.snapshots.push(s);
    await o.onSnapshot?.(s);
  };
  const searches: RawSnapshot[] = [];
  for (const team of o.teams) {
    const id = `snap_${WIKIDATA_SOURCE_ID}_wd_search_fd_${team.fdId}`;
    const prev = o.have.get(id);
    if (prev && !o.refresh) {
      searches.push(prev);
      continue;
    }
    const r = await client.searchClub(team, at());
    if (!r.ok) {
      report.skipped.push({ what: `search ${team.name}`, reason: r.reason });
      if (r.reason === 'NETWORK') return { ...report, calls: client.calls.length };
      continue;
    }
    searches.push(r.snapshot);
    await keep(r.snapshot);
  }
  const candidates = searches.flatMap(
    (s) => SearchPayload.safeParse(s.payload).data?.results.map((x) => x.id) ?? [],
  );
  // Validate candidate items in batches (one large VALUES query can time out on the public endpoint).
  const ids = [...new Set(candidates.filter((x) => QID.test(x)))].sort();
  const clubSnaps = o.refresh ? [] : [...o.have.values()].filter((s) => s.recordType === 'wd_clubs');
  const covered = new Set(clubSnaps.flatMap((s) => ClubsPayload.safeParse(s.payload).data?.ids ?? []));
  const todo = ids.filter((x) => !covered.has(x));
  for (let i = 0; i < todo.length; i += WD_VALIDATE_BATCH) {
    const r = await client.validateClubs(todo.slice(i, i + WD_VALIDATE_BATCH), at());
    if (!r.ok) {
      report.skipped.push({ what: 'club validation', reason: r.reason });
      return { ...report, calls: client.calls.length };
    }
    clubSnaps.push(r.snapshot);
    await keep(r.snapshot);
  }
  const resolved = resolveClubs(searches, clubSnaps);
  o.onProgress?.(`wikidata: ${resolved.size} clubs resolved of ${o.teams.length}`);
  for (const club of new Set(resolved.values())) {
    const id = `snap_${WIKIDATA_SOURCE_ID}_wd_club_players_${club.qid}`;
    if (o.have.has(id) && !o.refresh) continue;
    const r = await client.clubPlayers(club.qid, at());
    if (!r.ok) {
      report.skipped.push({ what: `players ${club.qid}`, reason: r.reason });
      if (r.reason === 'NETWORK') break;
      continue;
    }
    await keep(r.snapshot);
  }
  return { ...report, calls: client.calls.length };
}

const SearchPayload = z.object({
  team: z.object({
    fdId: z.number(),
    name: z.string(),
    shortName: z.string().nullable(),
    competitionCode: z.string().nullable(),
  }),
  results: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
});
const ClubsPayload = z.object({ ids: z.array(z.string()), rows: z.array(z.record(z.string(), z.string())) });
const PlayersPayload = z.object({ club: z.string(), rows: z.array(z.record(z.string(), z.string())) });

/** Descriptions that mark a different team of the same club (women's side, youth, reserves). */
const NOT_FIRST_TEAM =
  /women|ladies|femen|fémin|frauen|femminile|youth|reserve|under-\d|u-?\d{2}\b|academy|\bii\b|\bb team/i;

export interface WdClub {
  qid: string;
  fdId: number;
  fdName: string;
  competitionCode: string | null;
  en: string;
  ar: string | null;
}

/**
 * Club resolution: among search hits that are validated association football clubs and not a
 * women's/youth/reserve side, the one with the most Wikipedia sitelinks. Two football-data clubs resolving to the same item are both
 * dropped (ambiguous) — never guessed.
 */
export function resolveClubs(searches: RawSnapshot[], clubs: RawSnapshot[]): Map<number, WdClub> {
  const valid = new Map<string, { en: string; ar: string | null; sl: number }>();
  const rows = [...clubs]
    .sort((a, b) => a.retrievedAt.localeCompare(b.retrievedAt)) // newest wins
    .flatMap((c) => ClubsPayload.safeParse(c.payload).data?.rows ?? []);
  for (const r of rows)
    if (r.c && QID.test(r.c)) valid.set(r.c, { en: r.en ?? '', ar: r.ar ?? null, sl: Number(r.sl) || 0 });
  const out = new Map<number, WdClub>();
  const owners = new Map<string, number[]>();
  for (const s of searches) {
    const p = SearchPayload.safeParse(s.payload);
    if (!p.success) continue;
    // Among valid first-team hits, the most-linked item is the club itself (duplicates and stubs
    // have few or no Wikipedia articles); search rank breaks ties.
    const hit = p.data.results
      .filter((x) => valid.has(x.id) && !NOT_FIRST_TEAM.test(`${x.label} ${x.description}`))
      .sort((a, b) => valid.get(b.id)!.sl - valid.get(a.id)!.sl)[0];
    if (!hit) continue;
    const v = valid.get(hit.id)!;
    out.set(p.data.team.fdId, {
      qid: hit.id,
      fdId: p.data.team.fdId,
      fdName: p.data.team.name,
      competitionCode: p.data.team.competitionCode,
      en: v.en || hit.label,
      ar: v.ar,
    });
    owners.set(hit.id, [...(owners.get(hit.id) ?? []), p.data.team.fdId]);
  }
  for (const ids of owners.values()) if (ids.length > 1) for (const id of ids) out.delete(id);
  return out;
}

// ---------------------------------------------------------------- knowledge base
export interface WdSpell {
  club: string;
  from: string | null;
  to: string | null;
  factId: string;
}
export interface WdPlayer {
  entityId: string;
  qid: string;
  en: string;
  ar: string | null;
  sitelinks: number;
  nationality: string | null;
  nationalityAr: string | null;
  spells: WdSpell[];
}
export interface WdKB {
  entities: Map<string, Entity>;
  facts: Fact[];
  factIndex: Map<string, Fact>;
  snapshots: Map<string, RawSnapshot>;
  clubs: Map<string, WdClub & { entityId: string }>;
  /** Club entity ids whose player list is loaded. Only these can be distractors or alternate links. */
  loadedClubs: Set<string>;
  players: Map<string, WdPlayer>;
  invalid: Array<{ snapshotId: string; error: string }>;
}

/**
 * Community labels can be vandalised (live example: an Arabic player label with two extra words).
 * An Arabic label is used only when it is Arabic script and has about as many words as the
 * English label; otherwise the English name is shown.
 */
export function plausibleArabic(en: string, ar: string | undefined): string | null {
  if (!ar) return null;
  const words = (x: string) => x.split(/[\s-]+/).filter(Boolean).length;
  if (!/^[\u0600-\u06FF\s\-'.]+$/.test(ar)) return null;
  if (words(ar) > words(en) + 1) return null;
  return ar;
}

const year = (v: string | undefined) => (v && /^\d{4}-/.test(v) ? v.slice(0, 10) : null);

export function normalizeWikidata(snaps: RawSnapshot[]): WdKB {
  const kb: WdKB = {
    entities: new Map(),
    facts: [],
    factIndex: new Map(),
    snapshots: new Map(),
    clubs: new Map(),
    loadedClubs: new Set(),
    players: new Map(),
    invalid: [],
  };
  const mine = snaps.filter((s) => s.sourceId === WIKIDATA_SOURCE_ID);
  for (const s of mine) kb.snapshots.set(s.id, s);
  const resolved = resolveClubs(
    mine.filter((s) => s.recordType === 'wd_search'),
    mine.filter((s) => s.recordType === 'wd_clubs'),
  );
  for (const c of resolved.values()) {
    const id = `wd_club_${c.qid}`;
    const local = CLUB_AR[c.fdId];
    const ar = local?.ar ?? c.ar;
    const aliases = [c.fdName, c.en, c.ar, local?.ar, ...(local?.aliases ?? [])].filter(
      (x): x is string => !!x,
    );
    kb.entities.set(id, {
      id,
      type: 'CLUB',
      name: c.en,
      names: { en: c.en, ...(ar ? { ar } : {}) },
      aliases: [...new Set(aliases)],
      sourceRefs: { [WIKIDATA_SOURCE_ID]: c.qid, src_football_data_org: String(c.fdId) },
    });
    kb.clubs.set(c.qid, { ...c, entityId: id });
  }
  let n = 0;
  for (const s of mine.filter((x) => x.recordType === 'wd_club_players')) {
    const p = PlayersPayload.safeParse(s.payload);
    if (!p.success) {
      kb.invalid.push({ snapshotId: s.id, error: p.error.message.slice(0, 200) });
      continue;
    }
    const club = kb.clubs.get(p.data.club);
    if (!club) continue; // club no longer resolves: its players are not used
    kb.loadedClubs.add(club.entityId);
    const seen = new Set<string>();
    for (const r of p.data.rows) {
      if (!r.p || !QID.test(r.p) || !r.en) continue;
      const from = year(r.from);
      const to = year(r.to);
      const key = `${r.p}|${from}|${to}`;
      const pid = `wd_player_${r.p}`;
      let pl = kb.players.get(pid);
      if (!pl) {
        r.ar = plausibleArabic(r.en, r.ar) ?? '';
        if (!r.ar) delete r.ar;
        pl = {
          entityId: pid,
          qid: r.p,
          en: r.en,
          ar: r.ar ?? null,
          sitelinks: Number(r.sl) || 0,
          nationality: r.nat ?? null,
          nationalityAr: r.natAr ?? null,
          spells: [],
        };
        kb.players.set(pid, pl);
        const surname = (x: string | null) => {
          const t = x?.split(' ').filter(Boolean) ?? [];
          return t.length > 1 && t.at(-1)!.length >= 4 ? t.at(-1)! : null;
        };
        kb.entities.set(pid, {
          id: pid,
          type: 'PLAYER',
          name: r.en,
          names: { en: r.en, ...(r.ar ? { ar: r.ar } : {}) },
          aliases: [
            ...new Set([r.en, r.ar, surname(r.en), surname(r.ar ?? null)].filter((x): x is string => !!x)),
          ],
          sourceRefs: { [WIKIDATA_SOURCE_ID]: r.p },
        });
      }
      if (seen.has(key)) continue; // same statement repeated by nationality rows
      seen.add(key);
      const f: Fact = {
        id: `wdfact_${++n}`,
        subject: pid,
        predicate: 'member_of_sports_team',
        value: club.entityId,
        scope: {
          competition: 'Club career (Wikidata P54)',
          season: null,
          cutoff: s.retrievedAt.slice(0, 10),
          statDefinition: 'Wikidata P54 "member of sports team" statement (loans included)',
        },
        sourceId: WIKIDATA_SOURCE_ID,
        evidenceId: s.id,
        version: 1,
        status: 'ACTIVE',
      };
      kb.facts.push(f);
      kb.factIndex.set(f.id, f);
      pl.spells.push({ club: club.entityId, from, to, factId: f.id });
    }
  }
  return kb;
}

// ---------------------------------------------------------------- question generation
const fp = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const ok = (gate: GateResult['gate'], message: string): GateResult => ({
  gate,
  passed: true,
  failureStatus: null,
  message,
});
const fail = (
  gate: GateResult['gate'],
  status: GateResult['failureStatus'],
  message: string,
): GateResult => ({
  gate,
  passed: false,
  failureStatus: status,
  message,
});
const clamp = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

export interface WdGenOptions {
  seed?: number;
  /** Impostor needs very famous names; Connections/MCQ can go a bit deeper. */
  impostorMinSitelinks?: number;
  memberMinSitelinks?: number;
  connectionsPerClub?: number;
}

export function generateWikidataCandidates(kb: WdKB, o: WdGenOptions = {}): Candidate[] {
  // Randomness is seeded per club / per player, so a question only changes when its own data does
  // (stable ids keep human reviews when more clubs are fetched later).
  const seedOf = (key: string) =>
    createRng(
      ((o.seed ?? 23) ^ Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16)) >>>
        0,
    );
  const impMin = o.impostorMinSitelinks ?? 60;
  const memMin = o.memberMinSitelinks ?? 45;
  const out: Candidate[] = [];
  const clubName = (id: string) => kb.entities.get(id)?.names.ar ?? kb.entities.get(id)?.name ?? id;
  const playerName = (p: WdPlayer) => p.ar ?? p.en;
  const clubsOf = (p: WdPlayer) => [...new Set(p.spells.map((s) => s.club))];
  const firstYear = (p: WdPlayer, club: string) =>
    p.spells
      .filter((s) => s.club === club && s.from)
      .map((s) => s.from!.slice(0, 4))
      .sort()[0] ?? null;
  const players = [...kb.players.values()].sort(
    (a, b) => b.sitelinks - a.sitelinks || a.qid.localeCompare(b.qid),
  );
  const rarity = (p: WdPlayer) => clamp(100 - p.sitelinks);

  // ---- The Impostor: a famous footballer; the context lists the clubs we can verify.
  for (const p of players.filter((x) => x.sitelinks >= impMin)) {
    const clubs = clubsOf(p).sort((a, b) =>
      (firstYear(p, a) ?? '9999').localeCompare(firstYear(p, b) ?? '9999'),
    );
    const nat = p.nationalityAr ?? p.nationality;
    out.push({
      kind: 'impostor',
      template: 'wd.imp.footballer',
      item: {
        kind: 'impostor',
        footballer: playerName(p),
        aliases: kb.entities.get(p.entityId)?.aliases ?? [p.en],
        context: [nat ? `منتخب: ${nat}` : null, `لعب في: ${clubs.map(clubName).join('، ')}`]
          .filter(Boolean)
          .join(' · '),
      },
      factIds: p.spells.map((s) => s.factId),
      entityIds: [p.entityId, ...clubs],
      fingerprint: fp(['wd_imp', p.qid]),
      validators: [ok('MODE_VALIDATOR', `Well-known footballer (${p.sitelinks} Wikipedia sitelinks)`)],
      components: {
        rarity: rarity(p),
        complexity: 20,
        distractorSimilarity: 0,
        temporalDistance: 30,
        recallDepth: 30,
      },
      secretStrings: [],
      preRevealText: [],
    });
  }

  // ---- Connections: four known players who all played for club X; no other shared club allowed.
  const members = new Map<string, WdPlayer[]>();
  for (const p of players.filter((x) => x.sitelinks >= memMin))
    for (const c of clubsOf(p)) members.set(c, [...(members.get(c) ?? []), p]);
  for (const [club, list] of [...members.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const used = new Set<string>();
    const rng = seedOf(club);
    for (let k = 0; k < (o.connectionsPerClub ?? 3); k++) {
      const four = shuffle(
        list.filter((p) => !used.has(p.qid)),
        rng,
      ).slice(0, 4);
      if (four.length < 4) break;
      four.forEach((p) => used.add(p.qid));
      const shared = clubsOf(four[0]!).filter((c) => c !== club && four.every((p) => clubsOf(p).includes(c)));
      const sameNat = !!four[0]!.nationality && four.every((p) => p.nationality === four[0]!.nationality);
      const e = kb.entities.get(club)!;
      out.push({
        kind: 'connection',
        template: 'wd.conn.same_club',
        item: {
          kind: 'connection',
          entities: four.map(playerName),
          link: clubName(club),
          aliases: e.aliases,
          explanation: `الأربعة لعبوا في ${clubName(club)} (حسب Wikidata).`,
        },
        factIds: four.flatMap((p) => p.spells.filter((s) => s.club === club).map((s) => s.factId)),
        entityIds: [club, ...four.map((p) => p.entityId)],
        fingerprint: fp(['wd_conn', club, four.map((p) => p.qid).sort()]),
        validators: [
          shared.length
            ? fail(
                'MODE_VALIDATOR',
                'REJECTED',
                `Alternate link: all four also played for ${shared.map(clubName).join(', ')}`,
              )
            : ok('MODE_VALIDATOR', 'All four share this club and no other fetched club'),
          sameNat
            ? fail('CLUES', 'REJECTED', `Alternate link: all four represent ${four[0]!.nationality}`)
            : ok('CLUES', 'No shared national team'),
        ],
        components: {
          rarity: clamp(four.reduce((a, p) => a + rarity(p), 0) / 4),
          complexity: 60,
          distractorSimilarity: 50,
          temporalDistance: 40,
          recallDepth: 70,
        },
        secretStrings: [e.name, ...(e.names.ar ? [e.names.ar] : [])],
        preRevealText: four.map(playerName),
      });
    }
  }

  // ---- MCQ: which of these clubs did the player play for? Distractors have no P54 statement for
  // the player in the fetched club lists (Wikidata can be incomplete: a reviewer confirms).
  const clubIds = [...kb.loadedClubs].sort();
  const league = (id: string) =>
    [...kb.clubs.values()].find((c) => c.entityId === id)?.competitionCode ?? null;
  for (const p of players.filter((x) => x.sitelinks >= memMin)) {
    const mine = clubsOf(p).sort();
    if (!mine.length) continue;
    const rng = seedOf(p.qid);
    const answer = mine[Math.floor(rng() * mine.length)]!;
    const same = clubIds.filter((c) => !mine.includes(c) && league(c) === league(answer));
    const pool = same.length >= 3 ? same : clubIds.filter((c) => !mine.includes(c));
    const distract = shuffle(pool, rng).slice(0, 3);
    if (distract.length < 3) continue;
    const opts = shuffle([answer, ...distract], rng);
    const options = opts.map((c, i) => ({ id: `o${i + 1}`, label: clubName(c) }));
    const labels = new Set(options.map((x) => normalizeAnswer(x.label)));
    out.push({
      kind: 'mcq',
      template: 'wd.mcq.played_for',
      item: {
        kind: 'mcq',
        prompt: `${playerName(p)} لعب في أنهي نادي من دول؟`,
        options,
        correctOptionId: options[opts.indexOf(answer)]!.id,
        explanation: `${playerName(p)} لعب في ${clubName(answer)}${firstYear(p, answer) ? ` (من ${firstYear(p, answer)})` : ''}.`,
      },
      factIds: p.spells.filter((s) => s.club === answer).map((s) => s.factId),
      entityIds: [p.entityId, ...opts],
      fingerprint: fp(['wd_mcq_played_for', p.qid, answer]),
      validators: [
        labels.size === 4
          ? ok('DISTRACTORS', 'Three fetched clubs with no membership statement for this player')
          : fail('DISTRACTORS', 'REJECTED', 'Duplicate option labels'),
      ],
      components: {
        rarity: rarity(p),
        complexity: 30,
        distractorSimilarity: same.length >= 3 ? 60 : 35,
        temporalDistance: 30,
        recallDepth: 45,
      },
      secretStrings: [],
      preRevealText: [],
    });
  }
  // ---- Buzzer (short answer): "which player played for A, B and C?" — only when exactly one fetched
  // player has all three memberships (any sitelink count), so the answer is unique in our data.
  const allPlayers = [...kb.players.values()];
  for (const p of players.filter((x) => x.sitelinks >= memMin)) {
    const mine = clubsOf(p).sort();
    if (mine.length < 3) continue;
    const rng = seedOf(`sa:${p.qid}`);
    const three = shuffle(mine, rng).slice(0, 3).sort();
    const others = allPlayers.filter((x) => x !== p && three.every((c) => clubsOf(x).includes(c)));
    const e = kb.entities.get(p.entityId)!;
    const names = three.map(clubName);
    out.push({
      kind: 'short_answer',
      template: 'wd.sa.player_by_clubs',
      item: {
        kind: 'short_answer',
        prompt: `مين اللاعيب اللي لعب في ${names[0]} و${names[1]} و${names[2]}؟`,
        answer: playerName(p),
        aliases: e.aliases,
        explanation: `${playerName(p)} لعب في التلات نوادي (حسب Wikidata).`,
      },
      factIds: p.spells.filter((x) => three.includes(x.club)).map((x) => x.factId),
      entityIds: [p.entityId, ...three],
      fingerprint: fp(['wd_sa_clubs', p.qid, three]),
      validators: [
        others.length === 0
          ? ok('MODE_VALIDATOR', 'Exactly one fetched player played for all three clubs')
          : fail(
              'MODE_VALIDATOR',
              'REJECTED',
              `Not unique: also ${others
                .slice(0, 3)
                .map((x) => x.en)
                .join(', ')}`,
            ),
      ],
      components: {
        rarity: rarity(p),
        complexity: 55,
        distractorSimilarity: 40,
        temporalDistance: 30,
        recallDepth: 60,
      },
      secretStrings: [p.en, ...(p.ar ? [p.ar] : [])],
      preRevealText: [`${names.join(' ')}`],
    });
  }
  // ---- Who Am I?: five clues, hardest first, drawn from a varied pool so no two players feel the
  // same. Every clue is derived from verified membership facts (or the label itself for name hints).
  const today = new Date().toISOString().slice(0, 10);
  const overlap = (a: WdSpell, b: WdSpell) =>
    !!a.from && !!b.from && a.from <= (b.to ?? today) && b.from <= (a.to ?? today);
  const tokens = (x: string) =>
    new Set(
      normalizeAnswer(x)
        .split(' ')
        .filter((t) => t.length > 2),
    );
  const leagueOf = (club: string) =>
    [...kb.clubs.values()].find((c) => c.entityId === club)?.competitionCode ?? null;
  for (const p of players.filter((x) => x.sitelinks >= impMin)) {
    const rng = seedOf(`wai:${p.qid}`);
    const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
    const clubs = clubsOf(p).sort();
    if (clubs.length < 2) continue; // too little to build five distinct clues
    const name = playerName(p);
    const own = new Set([...tokens(p.en), ...(p.ar ? tokens(p.ar) : [])]);
    type Clue = { text: string; facts: string[]; clubs: string[]; nat?: boolean; initial?: boolean };
    // A famous teammate: overlapping spell at the same club, no shared name token (no leaks).
    const mates: Array<{ mate: WdPlayer; club: string; facts: string[] }> = [];
    for (const sp of p.spells)
      for (const q of players)
        if (q !== p && q.sitelinks >= impMin && ![...tokens(q.en)].some((t) => own.has(t)))
          for (const sq of q.spells)
            if (sq.club === sp.club && overlap(sp, sq))
              mates.push({ mate: q, club: sp.club, facts: [sp.factId, sq.factId] });
    mates.sort((a, b) => b.mate.sitelinks - a.mate.sitelinks);
    const mate = mates.length ? mates[Math.floor(rng() * Math.min(3, mates.length))]! : null;
    const leagues = [...new Set(clubs.map(leagueOf).filter((x): x is string => !!x && !!COMPETITION_AR[x]))];
    const spellsWithYear = p.spells.filter((x) => x.from);
    const hard: Clue[] = [
      ...(mate
        ? [{ text: `لعب جنب ${playerName(mate.mate)} في نفس الفريق`, facts: mate.facts, clubs: [] }]
        : []),
      ...(leagues.length >= 2
        ? [
            {
              text: `لعب لنوادي في ${leagues
                .slice(0, 2)
                .map((l) => COMPETITION_AR[l])
                .join(' و')}`,
              facts: [],
              clubs: [],
            },
          ]
        : leagues.length === 1
          ? [{ text: `لعب لنادي من نوادي ${COMPETITION_AR[leagues[0]!]}`, facts: [], clubs: [] }]
          : []),
    ];
    const medium: Clue[] = [
      ...(p.nationalityAr || p.nationality
        ? [{ text: `بيلعب لمنتخب ${p.nationalityAr ?? p.nationality}`, facts: [], clubs: [], nat: true }]
        : []),
      ...spellsWithYear.map((x) => {
        const decade = Math.floor(Number(x.from!.slice(0, 4)) / 10) * 10;
        return {
          text: `انضم لـ${clubName(x.club)} في وقت ما بين ${decade} و${decade + 9}`,
          facts: [x.factId],
          clubs: [x.club],
        };
      }),
    ];
    const easy: Clue[] = spellsWithYear.map((x) => ({
      text: `انضم لـ${clubName(x.club)} سنة ${x.from!.slice(0, 4)}`,
      facts: [x.factId],
      clubs: [x.club],
    }));
    const clubClues: Clue[] = clubs.map((c) => ({
      text: `لعب كمان في ${clubName(c)}`,
      facts: p.spells.filter((x) => x.club === c).map((x) => x.factId),
      clubs: [c],
    }));
    const first = [...name].find((ch) => /\p{L}/u.test(ch)) ?? '';
    const last = name.split(' ').filter(Boolean).at(-1) ?? name;
    const nameClues: Clue[] = [
      { text: `اسمه بيبدأ بحرف «${first}»`, facts: [], clubs: [], initial: true },
      {
        text: `اسمه الأخير ${[...last].length} حروف وبيبدأ بـ«${[...last][0] ?? ''}»`,
        facts: [],
        clubs: [],
        initial: true,
      },
    ];
    const chosen: Clue[] = [];
    const usedClubs = new Set<string>();
    const take = (pool: Clue[]) => {
      const fresh = pool.filter((c) => !chosen.includes(c) && c.clubs.every((x) => !usedClubs.has(x)));
      const c = pick(fresh);
      if (!c) return false;
      chosen.push(c);
      c.clubs.forEach((x) => usedClubs.add(x));
      return true;
    };
    take(hard.length ? hard : medium);
    take(medium);
    take(easy.length ? easy : clubClues);
    if (!take(clubClues) && !take(easy)) take(medium);
    take(nameClues);
    if (chosen.length < 5) continue;
    // Uniqueness among every fetched player: same national team (if used), all named clubs, initial.
    const natUsed = chosen.some((c) => c.nat);
    const named = [...usedClubs];
    const initial = chosen.some((c) => c.initial);
    const others = allPlayers.filter((q) => {
      if (q === p) return false;
      if (natUsed && q.nationality !== p.nationality) return false;
      if (!named.every((c) => clubsOf(q).includes(c))) return false;
      if (initial && [...playerName(q)][0] !== [...name][0]) return false;
      return true;
    });
    const e = kb.entities.get(p.entityId)!;
    const rivals = allPlayers
      .filter((q) => q !== p && q.nationality === p.nationality)
      .slice(0, 30)
      .flatMap((q) => [q.en, ...(q.ar ? [q.ar] : [])]);
    out.push({
      kind: 'who_am_i',
      template: 'wd.wai.player',
      item: {
        kind: 'who_am_i',
        clues: chosen.map((c) => c.text) as [string, string, string, string, string],
        answer: name,
        aliases: e.aliases,
        rivals,
      },
      factIds: [...new Set([...chosen.flatMap((c) => c.facts), ...p.spells.map((x) => x.factId)])],
      entityIds: [p.entityId, ...named],
      fingerprint: fp(['wd_wai', p.qid]),
      validators: [
        others.length === 0
          ? ok('MODE_VALIDATOR', 'Five distinct clues; no other fetched player fits them all')
          : fail(
              'MODE_VALIDATOR',
              'REJECTED',
              `Clues also fit ${others
                .slice(0, 3)
                .map((x) => x.en)
                .join(', ')}`,
            ),
        new Set(chosen.map((c) => c.text)).size === 5
          ? ok('CLUES', 'Five different clues')
          : fail('CLUES', 'REJECTED', 'Repeated clue'),
      ],
      components: {
        rarity: rarity(p),
        complexity: 50,
        distractorSimilarity: 30,
        temporalDistance: 30,
        recallDepth: 50,
      },
      secretStrings: [p.en, ...(p.ar ? [p.ar] : [])],
      preRevealText: chosen.map((c) => c.text),
    });
  }
  return out;
}
