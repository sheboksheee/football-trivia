import { createRng, MODES, type ContentItem, type McqItem, type ModeKey } from '@ft/shared';
import {
  DEV_POLICY,
  fixtureSnapshots,
  generateLeague,
  runPipeline,
  SOURCES,
  STRICT_POLICY,
  type Question,
  type QuestionBank,
  type ReviewAction,
  type PipelineResult,
} from '@ft/content';
import { engineFor } from '@ft/game-rules';
import type { Persistence } from './persistence.js';
import type { Logger } from './logger.js';

export class ContentService {
  bank!: QuestionBank;
  result!: PipelineResult;
  constructor(
    private readonly db: Persistence,
    private readonly log: Logger,
    private readonly strict: boolean,
  ) {}

  async init() {
    const t = Date.now();
    this.result = runPipeline(this.strict ? STRICT_POLICY : DEV_POLICY);
    this.bank = this.result.bank;
    // Human review decisions persisted earlier are authoritative over regenerated status.
    const stored = await this.db.loadQuestions();
    let restored = 0;
    for (const q of this.bank.all()) {
      const prev = stored.get(q.id);
      if (prev && prev.fingerprint === q.fingerprint && prev.audit.some((a) => a.actor !== 'pipeline')) {
        this.bank.upsert({ ...q, status: prev.status, audit: prev.audit, difficulty: prev.difficulty });
        restored++;
      }
    }
    await this.db.saveSources(SOURCES);
    if (this.db.kind === 'postgres') await this.db.saveSnapshots(fixtureSnapshots(generateLeague()));
    await this.db.saveQuestions(this.bank.all().filter((q) => !stored.has(q.id)));
    this.log.info(
      { ms: Date.now() - t, counts: this.bank.counts(), conflicts: this.result.conflicts.length, restored },
      'content bank ready',
    );
  }

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
      return this.bank.draw(engine.contentKind, engine.itemsNeeded(playerCount), rng, used);
    });
    const tiebreak = this.bank.draw('mcq', 5, rng, used) as McqItem[];
    return { content, tiebreak };
  }

  availability(): Record<string, { published: number }> {
    const c = this.bank.counts();
    return Object.fromEntries(
      Object.values(MODES).map((m) => {
        if (m.rulesStatus === 'BLOCKED') return [m.key, { published: 0 }];
        const kind = engineFor(m.key).contentKind;
        return [m.key, { published: c[kind]?.PUBLISHED ?? 0 }];
      }),
    );
  }

  async review(id: string, action: ReviewAction, reviewer: string, note: string): Promise<Question> {
    const q = this.bank.review(id, action, reviewer, note);
    await this.db.saveQuestions([q]);
    this.log.info({ questionId: id, action, reviewer, status: q.status }, 'question reviewed');
    return q;
  }
}
