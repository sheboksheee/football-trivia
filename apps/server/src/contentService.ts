import { createRng, MODES, shuffle, type ContentItem, type McqItem, type ModeKey } from '@ft/shared';
import {
  DEV_POLICY,
  FOOTBALL_DATA_SOURCE_ID,
  FootballDataClient,
  OPENFOOTBALL_SOURCE_ID,
  WIKIDATA_SOURCE_ID,
  WikidataClient,
  ingestOpenFootball,
  ingestWikidata,
  fixtureSnapshots,
  generateLeague,
  hasCommercialRights,
  ingestFootballData,
  restoreSourceLicense,
  runPipeline,
  setSourceLicense,
  sourceById,
  SOURCES,
  STRICT_POLICY,
  type FetchLike,
  type IngestReport,
  type Question,
  type QuestionBank,
  type QuestionStatus,
  type RawSnapshot,
  type ReviewAction,
  type PipelineResult,
  type SourceRecord,
} from '@ft/content';
import { engineFor } from '@ft/game-rules';
import type { Persistence } from './persistence.js';
import type { Logger } from './logger.js';

/** Statuses produced by failed gates. A human decision can never override these on reload. */
const HARD_FAILURES: QuestionStatus[] = [
  'BLOCKED_RIGHTS',
  'QUARANTINED',
  'NEEDS_EVIDENCE',
  'REJECTED',
  'DUPLICATE',
];

export interface FootballDataSettings {
  enabled: boolean;
  token?: string | undefined;
  competitions: string[];
  seasons: number[];
  fetch?: FetchLike;
  minIntervalMs?: number;
}

export interface OpenDataSettings {
  /** Wikidata (club careers) + OpenFootball (results cross-check), both CC0. */
  enabled: boolean;
  fetch?: FetchLike;
  minIntervalMs?: number;
}

export interface OpenDataStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastReport: {
    wikidata: { added: number; calls: number; skipped: Array<{ what: string; reason: string }> };
    openFootball: { added: number; calls: number; skipped: Array<{ what: string; reason: string }> };
    error: string | null;
  } | null;
  snapshots: { wikidata: number; openFootball: number };
  crossCheck: { compared: number; agreed: number; conflicts: number; unmatchedTeams: string[] } | null;
}

export interface ContentOptions {
  strict: boolean;
  /** Production launches only draw from sources with COMMERCIAL_REDISTRIBUTION rights. */
  requireCommercialRights: boolean;
  footballData?: FootballDataSettings;
  openData?: OpenDataSettings;
}

export interface IngestStatus {
  enabled: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastReport: { added: number; skipped: IngestReport['skipped']; calls: number; error: string | null } | null;
  snapshots: number;
  competitions: string[];
  seasons: number[];
}

export class ContentService {
  bank!: QuestionBank;
  result!: PipelineResult;
  private fdSnapshots: RawSnapshot[] = [];
  private wdSnapshots: RawSnapshot[] = [];
  private ofSnapshots: RawSnapshot[] = [];
  private ingest: IngestStatus;
  private open: { running: boolean; lastRunAt: string | null; lastReport: OpenDataStatus['lastReport'] } = {
    running: false,
    lastRunAt: null,
    lastReport: null,
  };

  constructor(
    private readonly db: Persistence,
    private readonly log: Logger,
    private readonly o: ContentOptions,
  ) {
    const fd = o.footballData;
    this.ingest = {
      enabled: !!fd?.enabled,
      running: false,
      lastRunAt: null,
      lastReport: null,
      snapshots: 0,
      competitions: fd?.competitions ?? [],
      seasons: fd?.seasons ?? [],
    };
  }

  async init() {
    for (const s of await this.db.loadSources()) restoreSourceLicense(s);
    this.fdSnapshots = await this.db.loadSnapshots(FOOTBALL_DATA_SOURCE_ID);
    this.wdSnapshots = await this.db.loadSnapshots(WIKIDATA_SOURCE_ID);
    this.ofSnapshots = await this.db.loadSnapshots(OPENFOOTBALL_SOURCE_ID);
    await this.rebuild();
    await this.db.saveSources(SOURCES);
    if (this.db.kind === 'postgres') await this.db.saveSnapshots(fixtureSnapshots(generateLeague()));
  }

  /**
   * Re-runs the pipeline (e.g. after new provider data or a license change). Persisted human
   * review decisions are restored only when the question still passes every hard gate.
   */
  async rebuild() {
    const t = Date.now();
    this.result = runPipeline(this.o.strict ? STRICT_POLICY : DEV_POLICY, undefined, {
      footballData: this.fdSnapshots,
      wikidata: this.wdSnapshots,
      openFootball: this.ofSnapshots,
    });
    const bank = this.result.bank;
    const stored = await this.db.loadQuestions();
    let restored = 0;
    for (const q of bank.all()) {
      const prev = stored.get(q.id);
      if (!prev || prev.fingerprint !== q.fingerprint || !prev.audit.some((a) => a.actor !== 'pipeline'))
        continue;
      if (HARD_FAILURES.includes(q.status)) {
        // e.g. a license was revoked: keep the failure, but keep the history visible.
        bank.upsert({ ...q, audit: [...prev.audit, ...q.audit.slice(-1)] });
        continue;
      }
      // Same verified facts (same fingerprint) but new wording, e.g. Arabic templates: keep the human
      // decision, bump the version and record the rewording in the audit trail.
      const wording = (x: Question) => JSON.stringify({ ...x.item, meta: undefined });
      if (wording(prev) !== wording(q)) {
        const version = prev.version + 1;
        bank.upsert({
          ...q,
          version,
          item: { ...q.item, meta: { ...q.item.meta, version } },
          status: prev.status,
          difficulty: prev.difficulty,
          audit: [
            ...prev.audit,
            {
              at: new Date().toISOString(),
              actor: 'pipeline',
              action: 'reworded',
              fromStatus: prev.status,
              toStatus: prev.status,
              note: 'Wording regenerated from the same verified facts (fingerprint unchanged)',
            },
          ],
        });
      } else {
        bank.upsert({
          ...q,
          version: prev.version,
          item: { ...q.item, meta: { ...q.item.meta, version: prev.version } },
          status: prev.status,
          audit: prev.audit,
          difficulty: prev.difficulty,
        });
      }
      restored++;
    }
    this.bank = bank;
    this.ingest.snapshots = this.fdSnapshots.length;
    await this.db.saveQuestions(
      bank.all().filter((q) => {
        const prev = stored.get(q.id);
        return !prev || prev.status !== q.status || prev.version !== q.version;
      }),
    );
    this.log.info(
      {
        ms: Date.now() - t,
        counts: bank.counts(),
        conflicts: this.result.conflicts.length,
        restored,
        footballDataSnapshots: this.fdSnapshots.length,
        invalidProviderPayloads: this.result.fdKb?.invalid.length ?? 0,
        wikidataSnapshots: this.wdSnapshots.length,
        openFootballSnapshots: this.ofSnapshots.length,
        crossCheck: this.result.crossCheck
          ? { compared: this.result.crossCheck.compared, conflicts: this.result.crossCheck.conflicts.length }
          : null,
      },
      'content bank ready',
    );
  }

  private allowedForPlay = (q: Question) =>
    !this.o.requireCommercialRights || q.sourceIds.every((id) => hasCommercialRights(id));

  /** Pins content for a whole Match Night at start (no mid-match drift), no repeats within the room. */
  drawForMatch(
    modes: ModeKey[],
    playerCount: number,
    seed: number,
    used: Set<string>,
  ): { content: ContentItem[][]; tiebreak: McqItem[] } {
    const rng = createRng(seed);
    const content = modes.map((k) => {
      const engine = engineFor(k);
      return this.drawPreferringReal(engine.contentKind, engine.itemsNeeded(playerCount), rng, used);
    });
    const tiebreak = this.drawPreferringReal('mcq', 5, rng, used) as McqItem[];
    return { content, tiebreak };
  }

  private isReal = (q: Question) => q.sourceIds.every((id) => sourceById(id)?.kind !== 'SYNTHETIC_FIXTURE');

  /**
   * Real (provider) questions first; fictional fixture questions only fill what is missing, so a
   * game is never blocked while the real bank is still small.
   */
  private drawPreferringReal(
    kind: ContentItem['kind'],
    count: number,
    rng: () => number,
    used: Set<string>,
  ): ContentItem[] {
    const realAllowed = (q: Question) => this.allowedForPlay(q) && this.isReal(q);
    const available = this.bank
      .all()
      .filter((q) => q.kind === kind && q.status === 'PUBLISHED' && !used.has(q.id) && realAllowed(q)).length;
    const real =
      available > 0
        ? this.bank.draw(kind, Math.min(count, available), rng, used, undefined, realAllowed)
        : [];
    const rest =
      real.length < count
        ? this.bank.draw(kind, count - real.length, rng, used, undefined, this.allowedForPlay)
        : [];
    return shuffle([...real, ...rest], rng);
  }

  /** Published, playable questions per mode, and how many a game needs for 2–6 players. */
  availability(): Record<string, { published: number; needed: Record<number, number> }> {
    const pub = this.bank.all().filter((q) => q.status === 'PUBLISHED' && this.allowedForPlay(q));
    return Object.fromEntries(
      Object.values(MODES).map((m) => {
        if (m.rulesStatus === 'BLOCKED') return [m.key, { published: 0, needed: {} }];
        const engine = engineFor(m.key);
        const needed = Object.fromEntries([2, 3, 4, 5, 6].map((n) => [n, engine.itemsNeeded(n)]));
        return [m.key, { published: pub.filter((q) => q.kind === engine.contentKind).length, needed }];
      }),
    );
  }

  async review(id: string, action: ReviewAction, reviewer: string, note: string): Promise<Question> {
    const q = this.bank.review(id, action, reviewer, note);
    await this.db.saveQuestions([q]);
    this.log.info({ questionId: id, action, reviewer, status: q.status }, 'question reviewed');
    return q;
  }

  /** Applies one human decision to many questions; each question gets its own audit entry. */
  async bulkReview(ids: string[], action: ReviewAction, reviewer: string, note: string) {
    const done: Question[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of ids.slice(0, 500)) {
      try {
        done.push(this.bank.review(id, action, reviewer, note));
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : 'failed' });
      }
    }
    await this.db.saveQuestions(done);
    this.log.info({ action, reviewer, done: done.length, failed: failed.length }, 'bulk review');
    return { done: done.length, failed };
  }

  async setLicense(
    id: string,
    decision: {
      status: SourceRecord['licenseStatus'];
      allowedUses: SourceRecord['allowedUses'];
      by: string;
      note: string;
    },
  ) {
    const s = setSourceLicense(id, decision);
    await this.db.saveSources([s]);
    this.log.warn(
      { sourceId: id, status: s.licenseStatus, uses: s.allowedUses, by: decision.by },
      'source license changed',
    );
    await this.rebuild();
    return s;
  }

  ingestStatus(): IngestStatus {
    return { ...this.ingest };
  }

  /** Fetches missing football-data.org records in the background, then rebuilds the bank. */
  startIngest(opts: { refresh?: boolean } = {}): IngestStatus {
    const fd = this.o.footballData;
    if (!fd?.enabled) throw new Error('football-data.org ingestion is not enabled on this server');
    if (this.ingest.running) return this.ingestStatus();
    this.ingest.running = true;
    const client = new FootballDataClient({
      ...(fd.token ? { token: fd.token } : {}),
      ...(fd.fetch ? { fetch: fd.fetch } : {}),
      ...(fd.minIntervalMs !== undefined ? { minIntervalMs: fd.minIntervalMs } : {}),
    });
    const have = new Set(this.fdSnapshots.map((s) => s.id));
    // Publish progressively: store each response immediately and rebuild the bank every few
    // responses, so the first real questions appear within about a minute instead of at the end.
    let sinceRebuild = 0;
    const absorb = async (snap: RawSnapshot) => {
      await this.db.saveSnapshots([snap]);
      this.fdSnapshots = [...this.fdSnapshots.filter((x) => x.id !== snap.id), snap];
      this.ingest.snapshots = this.fdSnapshots.length;
      if (++sinceRebuild >= 5) {
        sinceRebuild = 0;
        await this.rebuild();
      }
    };
    void ingestFootballData(client, {
      competitions: fd.competitions,
      seasons: fd.seasons,
      have,
      refresh: !!opts.refresh,
      onProgress: (msg) => this.log.info({ msg }, 'football-data ingest'),
      onSnapshot: absorb,
    })
      .then(async (report) => {
        if (sinceRebuild > 0) await this.rebuild();
        this.ingest.lastReport = {
          added: report.snapshots.length,
          skipped: report.skipped,
          calls: report.calls,
          error: null,
        };
      })
      .catch((err: unknown) => {
        this.log.error({ err }, 'football-data ingest failed');
        this.ingest.lastReport = {
          added: 0,
          skipped: [],
          calls: 0,
          error: err instanceof Error ? err.message : 'failed',
        };
      })
      .finally(() => {
        this.ingest.running = false;
        this.ingest.lastRunAt = new Date().toISOString();
      });
    return this.ingestStatus();
  }

  openDataStatus(): OpenDataStatus {
    const cc = this.result?.crossCheck;
    return {
      enabled: !!this.o.openData?.enabled,
      ...this.open,
      snapshots: { wikidata: this.wdSnapshots.length, openFootball: this.ofSnapshots.length },
      crossCheck: cc
        ? {
            compared: cc.compared,
            agreed: cc.agreed,
            conflicts: cc.conflicts.length,
            unmatchedTeams: cc.unmatchedTeams,
          }
        : null,
    };
  }

  /**
   * Fetches Wikidata club careers for the football-data.org clubs we know, and OpenFootball files
   * for the configured league seasons, in the background (after any football-data run finishes).
   */
  startOpenDataIngest(opts: { refresh?: boolean } = {}): OpenDataStatus {
    const od = this.o.openData;
    if (!od?.enabled) throw new Error('Open-data ingestion is not enabled on this server');
    if (this.open.running) return this.openDataStatus();
    this.open.running = true;
    const run = async () => {
      while (this.ingest.running) await new Promise((r) => setTimeout(r, 200));
      const fdKb = this.result.fdKb;
      const league = new Map<string, string>();
      for (const t of fdKb?.tables ?? []) for (const r of t.rows) league.set(r.team, t.competitionCode);
      const teams = [...(fdKb?.teams.values() ?? [])]
        .map((t) => ({
          fdId: Number(t.entityId.replace('fd_team_', '')),
          name: t.name,
          shortName: t.shortName,
          competitionCode: league.get(t.entityId) ?? null,
        }))
        .filter((t) => Number.isInteger(t.fdId))
        .sort((a, b) => a.fdId - b.fdId);
      const wdHave = new Map(this.wdSnapshots.map((s) => [s.id, s]));
      const client = new WikidataClient({
        ...(od.fetch ? { fetch: od.fetch } : {}),
        ...(od.minIntervalMs !== undefined ? { minIntervalMs: od.minIntervalMs } : {}),
      });
      // One rebuild at the end: open-data runs are a few minutes and rebuilds are the costly part.
      const absorbWd = async (snap: RawSnapshot) => {
        await this.db.saveSnapshots([snap]);
        this.wdSnapshots = [...this.wdSnapshots.filter((x) => x.id !== snap.id), snap];
      };
      const wd = await ingestWikidata(client, {
        teams,
        have: wdHave,
        refresh: !!opts.refresh,
        onSnapshot: absorbWd,
        onProgress: (msg) => this.log.info({ msg }, 'wikidata ingest'),
      });
      const of = await ingestOpenFootball({
        competitions: this.o.footballData?.competitions ?? [],
        seasons: this.o.footballData?.seasons ?? [],
        have: new Set(this.ofSnapshots.map((s) => s.id)),
        refresh: !!opts.refresh,
        ...(od.fetch ? { fetch: od.fetch } : {}),
        onSnapshot: async (snap) => {
          await this.db.saveSnapshots([snap]);
          this.ofSnapshots = [...this.ofSnapshots.filter((x) => x.id !== snap.id), snap];
        },
      });
      await this.rebuild();
      this.open.lastReport = {
        wikidata: { added: wd.snapshots.length, calls: wd.calls, skipped: wd.skipped },
        openFootball: { added: of.snapshots.length, calls: of.calls, skipped: of.skipped },
        error: null,
      };
    };
    void run()
      .catch((err: unknown) => {
        this.log.error({ err }, 'open-data ingest failed');
        this.open.lastReport = {
          wikidata: { added: 0, calls: 0, skipped: [] },
          openFootball: { added: 0, calls: 0, skipped: [] },
          error: err instanceof Error ? err.message : 'failed',
        };
      })
      .finally(() => {
        this.open.running = false;
        this.open.lastRunAt = new Date().toISOString();
      });
    return this.openDataStatus();
  }

  /** Test helper: resolves when the open-data run has finished. */
  async waitForOpenData(timeoutMs = 10_000) {
    const start = Date.now();
    while (this.open.running && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 20));
  }

  /** Test helper: resolves when the current ingestion run has finished. */
  async waitForIngest(timeoutMs = 10_000) {
    const start = Date.now();
    while (this.ingest.running && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 20));
  }

  source(id: string) {
    return sourceById(id);
  }
}
