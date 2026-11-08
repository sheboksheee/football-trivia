import { createRng, MODES, shuffle, type ContentItem, type McqItem, type ModeKey } from '@ft/shared';
import {
  DEV_POLICY,
  FOOTBALL_DATA_SOURCE_ID,
  FootballDataClient,
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

export interface ContentOptions {
  strict: boolean;
  /** Production launches only draw from sources with COMMERCIAL_REDISTRIBUTION rights. */
  requireCommercialRights: boolean;
  footballData?: FootballDataSettings;
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
  private ingest: IngestStatus;

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
      bank.upsert({ ...q, status: prev.status, audit: prev.audit, difficulty: prev.difficulty });
      restored++;
    }
    this.bank = bank;
    this.ingest.snapshots = this.fdSnapshots.length;
    await this.db.saveQuestions(
      bank.all().filter((q) => stored.get(q.id)?.status !== q.status || !stored.has(q.id)),
    );
    this.log.info(
      {
        ms: Date.now() - t,
        counts: bank.counts(),
        conflicts: this.result.conflicts.length,
        restored,
        footballDataSnapshots: this.fdSnapshots.length,
        invalidProviderPayloads: this.result.fdKb?.invalid.length ?? 0,
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

  availability(): Record<string, { published: number }> {
    const pub = this.bank.all().filter((q) => q.status === 'PUBLISHED' && this.allowedForPlay(q));
    return Object.fromEntries(
      Object.values(MODES).map((m) => {
        if (m.rulesStatus === 'BLOCKED') return [m.key, { published: 0 }];
        const kind = engineFor(m.key).contentKind;
        return [m.key, { published: pub.filter((q) => q.kind === kind).length }];
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
    void ingestFootballData(client, {
      competitions: fd.competitions,
      seasons: fd.seasons,
      have,
      refresh: !!opts.refresh,
      onProgress: (msg) => this.log.info({ msg }, 'football-data ingest'),
    })
      .then(async (report) => {
        if (report.snapshots.length) {
          await this.db.saveSnapshots(report.snapshots);
          const byId = new Map(this.fdSnapshots.map((s) => [s.id, s]));
          for (const s of report.snapshots) byId.set(s.id, s);
          this.fdSnapshots = [...byId.values()];
          await this.rebuild();
        }
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

  /** Test helper: resolves when the current ingestion run has finished. */
  async waitForIngest(timeoutMs = 10_000) {
    const start = Date.now();
    while (this.ingest.running && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 20));
  }

  source(id: string) {
    return sourceById(id);
  }
}
