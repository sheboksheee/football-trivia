import { afterAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { fakeApi } from '../../../services/content/test/fdFake.js';
import { fakeWikidata } from '../../../services/content/test/wdFake.js';

const apps: App[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});

async function boot(env: Record<string, string>) {
  const api = fakeApi();
  const app = await createApp(
    loadConfig({
      LOG_LEVEL: 'silent',
      ADMIN_TOKEN: 'admin-test-token',
      FOOTBALL_DATA_ENABLED: 'true',
      FOOTBALL_DATA_COMPETITIONS: 'FPL',
      FOOTBALL_DATA_SEASONS: '2024,2025',
      ...env,
    } as NodeJS.ProcessEnv),
    { log: pino({ level: 'silent' }), footballDataFetch: api.f, openDataFetch: fakeWikidata().f },
  );
  apps.push(app);
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}/api/admin`;
  const call = async (path: string, init?: RequestInit) => {
    const r = await fetch(base + path, {
      ...init,
      headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { app, api, call };
}

describe('football-data.org through the server', () => {
  it('ingests in the background, blocks on license, publishes only after human approval', async () => {
    const { app, api, call } = await boot({});
    await app.content.waitForIngest();
    expect(api.seen.length).toBe(6); // 1 competition x 2 seasons x (matches, standings, teams)
    const st = await call('/sources');
    expect(st.body.footballData).toMatchObject({ enabled: true, running: false, snapshots: 6 });
    const fdSource = 'src_football_data_org';
    const blocked = await call(`/questions?source=${fdSource}&status=BLOCKED_RIGHTS&limit=1`);
    expect(blocked.body.total).toBeGreaterThan(20);

    // License approval requires a note and validated uses
    expect(
      (
        await call(`/sources/${fdSource}/license`, {
          method: 'POST',
          body: JSON.stringify({ status: 'APPROVED', allowedUses: [], note: 'x' }),
        })
      ).status,
    ).toBe(400);
    const lic = await call(`/sources/${fdSource}/license`, {
      method: 'POST',
      body: JSON.stringify({
        status: 'APPROVED',
        allowedUses: ['GAMEPLAY'],
        note: 'Free plan, private testing only',
        reviewer: 'owner',
      }),
    });
    expect(lic.status).toBe(200);
    expect(lic.body.source.licenseHistory).toHaveLength(1);

    // Now everything waits for human review: nothing real is auto-published
    const review = await call(
      `/questions?source=${fdSource}&status=NEEDS_REVIEW&template=fd.hl.points&limit=100`,
    );
    expect(review.body.total).toBeGreaterThanOrEqual(3);
    expect((await call(`/questions?source=${fdSource}&status=PUBLISHED`)).body.total).toBe(0);
    const before = (await (
      await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/modes`)
    ).json()) as any;
    const ids = review.body.items.map((q: any) => q.id);
    const bulk = await call('/questions/bulk-review', {
      method: 'POST',
      body: JSON.stringify({
        ids,
        action: 'APPROVE',
        note: 'Checked against the source table',
        reviewer: 'owner',
      }),
    });
    expect(bulk.body).toEqual({ done: ids.length, failed: [] });
    const after = (await (
      await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/modes`)
    ).json()) as any;
    expect(after.availability.higher_lower.published).toBe(
      before.availability.higher_lower.published + ids.length,
    );
    // Evidence for a real question points at a football-data snapshot
    const detail = await call(`/questions/${ids[0]}`);
    expect(detail.body.facts[0].sourceId).toBe(fdSource);
    expect(detail.body.facts[0].evidence.hash).toMatch(/^[0-9a-f]{64}$/);

    // Revoking the license blocks the questions again even though they were approved before
    await call(`/sources/${fdSource}/license`, {
      method: 'POST',
      body: JSON.stringify({ status: 'PENDING', allowedUses: [], note: 'Waiting for written confirmation' }),
    });
    expect((await call(`/questions?source=${fdSource}&status=PUBLISHED`)).body.total).toBe(0);
  });

  it('a launch that requires commercial rights never draws questions from a GAMEPLAY-only source', async () => {
    const { ContentService } = await import('../src/contentService.js');
    const { MemoryPersistence } = await import('../src/persistence.js');
    const api = fakeApi();
    const svc = new ContentService(new MemoryPersistence(), pino({ level: 'silent' }), {
      strict: false,
      requireCommercialRights: true,
      footballData: {
        enabled: true,
        competitions: ['FPL'],
        seasons: [2024, 2025],
        fetch: api.f,
        minIntervalMs: 0,
      },
    });
    await svc.init();
    svc.startIngest();
    await svc.waitForIngest();
    await svc.setLicense('src_football_data_org', {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY'],
      by: 'owner',
      note: 'private testing',
    });
    const fdIds = svc.bank
      .all()
      .filter((q) => q.sourceIds.includes('src_football_data_org') && q.status === 'NEEDS_REVIEW')
      .map((q) => q.id);
    expect((await svc.bulkReview(fdIds, 'APPROVE', 'owner', 'checked')).done).toBe(fdIds.length);
    const drawn = svc.drawForMatch(['higher_lower', 'guess_the_match', 'timeline'], 2, 1, new Set());
    const all = [...drawn.content.flat(), ...drawn.tiebreak];
    expect(all.some((i) => i.meta.sourceIds.includes('src_football_data_org'))).toBe(false);
    // With commercial rights recorded, real questions become eligible.
    await svc.setLicense('src_football_data_org', {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY', 'COMMERCIAL_REDISTRIBUTION'],
      by: 'owner',
      note: 'written confirmation received',
    });
    const used = new Set<string>();
    let sawReal = false;
    for (let seed = 0; seed < 30 && !sawReal; seed++) {
      try {
        sawReal = svc
          .drawForMatch(['higher_lower'], 2, seed, used)
          .content.flat()
          .some((i) => i.meta.sourceIds.includes('src_football_data_org'));
      } catch {
        break;
      }
    }
    expect(sawReal).toBe(true);
  });
  it('games use real questions first and fill the rest with fictional ones', async () => {
    const { ContentService } = await import('../src/contentService.js');
    const { MemoryPersistence } = await import('../src/persistence.js');
    const svc = new ContentService(new MemoryPersistence(), pino({ level: 'silent' }), {
      strict: false,
      requireCommercialRights: false,
      footballData: {
        enabled: true,
        competitions: ['FPL'],
        seasons: [2024, 2025],
        fetch: fakeApi().f,
        minIntervalMs: 0,
      },
    });
    await svc.init();
    svc.startIngest();
    await svc.waitForIngest();
    await svc.setLicense('src_football_data_org', {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY'],
      by: 'owner',
      note: 'testing',
    });
    const hl = svc.bank
      .all()
      .filter(
        (q) =>
          q.sourceIds.includes('src_football_data_org') &&
          q.kind === 'higher_lower' &&
          q.status === 'NEEDS_REVIEW',
      );
    // Approve only 3 real Higher-or-Lower items: a 5-item game takes all 3 real + 2 fictional.
    await svc.bulkReview(
      hl.slice(0, 3).map((q) => q.id),
      'APPROVE',
      'owner',
      'checked',
    );
    const items = svc.drawForMatch(['higher_lower'], 2, 7, new Set()).content[0]!;
    expect(items).toHaveLength(5);
    expect(items.filter((i) => i.meta.sourceIds.includes('src_football_data_org'))).toHaveLength(3);
  });
  it('rewording an approved question (same facts) keeps the approval, bumps the version once, and audits it', async () => {
    const { ContentService } = await import('../src/contentService.js');
    const { MemoryPersistence } = await import('../src/persistence.js');
    const db = new MemoryPersistence();
    const svc = new ContentService(db, pino({ level: 'silent' }), {
      strict: false,
      requireCommercialRights: false,
      footballData: {
        enabled: true,
        competitions: ['FPL'],
        seasons: [2024, 2025],
        fetch: fakeApi().f,
        minIntervalMs: 0,
      },
    });
    await svc.init();
    svc.startIngest();
    await svc.waitForIngest();
    await svc.setLicense('src_football_data_org', {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY'],
      by: 'owner',
      note: 'testing',
    });
    const q = svc.bank.all().find((x) => x.template === 'fd.mcq.champion' && x.status === 'NEEDS_REVIEW')!;
    await svc.review(q.id, 'APPROVE', 'owner', 'checked');
    // Simulate the old (English) wording stored before the Arabic templates.
    const stored = db.questions.get(q.id)!;
    db.questions.set(q.id, {
      ...stored,
      item: { ...stored.item, prompt: 'Who finished top of the table?' } as never,
    });
    await svc.rebuild();
    const after = svc.bank.get(q.id)!;
    expect(after.status).toBe('PUBLISHED');
    expect(after.version).toBe(2);
    expect(after.item.meta.version).toBe(2);
    expect((after.item as { prompt: string }).prompt).toContain('مين خلّص في صدارة');
    expect(after.audit.at(-1)!.action).toBe('reworded');
    await svc.rebuild();
    expect(svc.bank.get(q.id)!.version).toBe(2); // not bumped again on the next restart
  });
});
