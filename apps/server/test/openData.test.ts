import { afterAll, afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { sourceById, WIKIDATA_SOURCE_ID, OPENFOOTBALL_SOURCE_ID } from '@ft/content';
import { loadConfig } from '../src/config.js';
import { createApp, type App } from '../src/app.js';
import { ContentService } from '../src/contentService.js';
import { MemoryPersistence } from '../src/persistence.js';
import { fakeApi } from '../../../services/content/test/fdFake.js';
import { fakeWikidata } from '../../../services/content/test/wdFake.js';

const apps: App[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});
afterEach(() => {
  for (const id of [WIKIDATA_SOURCE_ID, OPENFOOTBALL_SOURCE_ID]) {
    const s = sourceById(id)!;
    s.licenseStatus = 'PENDING';
    s.allowedUses = [];
    s.licenseHistory = [];
  }
});

const settings = (wd: ReturnType<typeof fakeWikidata>) => ({
  strict: true,
  requireCommercialRights: false,
  footballData: {
    enabled: true,
    competitions: ['FPL'],
    seasons: [2024],
    fetch: fakeApi().f,
    minIntervalMs: 0,
  },
  openData: { enabled: true, fetch: wd.f, minIntervalMs: 0 },
});

describe('open data (Wikidata + OpenFootball) through the server', () => {
  it('runs after football-data, stores snapshots, and re-uses them after a restart', async () => {
    const db = new MemoryPersistence();
    const wd = fakeWikidata();
    const svc = new ContentService(db, pino({ level: 'silent' }), settings(wd));
    await svc.init();
    svc.startIngest();
    svc.startOpenDataIngest();
    await svc.waitForIngest();
    await svc.waitForOpenData();
    const st = svc.openDataStatus();
    expect(st.lastReport!.error).toBeNull();
    expect(st.snapshots.wikidata).toBe(12); // 6 searches + 1 validation + 5 resolved clubs
    const wdQs = svc.bank.all().filter((q) => q.sourceIds.includes(WIKIDATA_SOURCE_ID));
    expect(wdQs.length).toBeGreaterThan(0);
    expect(wdQs.every((q) => q.status === 'BLOCKED_RIGHTS')).toBe(true);

    // License decision (audited) -> questions go to human review, never straight to play.
    await svc.setLicense(WIKIDATA_SOURCE_ID, {
      status: 'APPROVED',
      allowedUses: ['GAMEPLAY', 'COMMERCIAL_REDISTRIBUTION'],
      by: 'owner',
      note: 'CC0 1.0 per Wikidata:Licensing',
    });
    const review = svc.bank.all().filter((q) => q.sourceIds.includes(WIKIDATA_SOURCE_ID));
    expect(review.some((q) => q.status === 'NEEDS_REVIEW')).toBe(true);
    expect(review.some((q) => q.status === 'PUBLISHED')).toBe(false);
    const imp = review.find((q) => q.kind === 'impostor' && q.status === 'NEEDS_REVIEW')!;
    await svc.review(imp.id, 'APPROVE', 'owner', 'checked');
    expect(svc.availability().impostor!.published).toBe(1);

    // Restart on the same database: no new Wikidata calls, the approval survives.
    const wd2 = fakeWikidata();
    const again = new ContentService(db, pino({ level: 'silent' }), settings(wd2));
    await again.init();
    again.startOpenDataIngest();
    await again.waitForOpenData();
    expect(wd2.seen).toHaveLength(0);
    expect(again.bank.get(imp.id)!.status).toBe('PUBLISHED');
  });

  it('admin API exposes status and starts a run; open data needs football-data clubs', async () => {
    const wd = fakeWikidata();
    const app = await createApp(
      loadConfig({
        LOG_LEVEL: 'silent',
        ADMIN_TOKEN: 'admin-test-token',
        FOOTBALL_DATA_ENABLED: 'true',
        FOOTBALL_DATA_COMPETITIONS: 'FPL',
        FOOTBALL_DATA_SEASONS: '2024',
      } as NodeJS.ProcessEnv),
      { log: pino({ level: 'silent' }), footballDataFetch: fakeApi().f, openDataFetch: wd.f },
    );
    apps.push(app);
    await app.content.waitForIngest();
    await app.content.waitForOpenData();
    const port = await app.listen(0, '127.0.0.1');
    const call = async (path: string, init?: RequestInit) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/admin${path}`, {
        ...init,
        headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    const s = await call('/sources');
    expect(s.body.openData.snapshots.wikidata).toBe(12);
    expect(s.body.sources.find((x: any) => x.id === WIKIDATA_SOURCE_ID).integrated).toBe(true);
    const r = await call('/open-data/ingest', { method: 'POST', body: '{}' });
    expect(r.status).toBe(202);
    await app.content.waitForOpenData();
    expect(wd.seen.length).toBe(12); // the second run had nothing new to fetch
    const q = await call(`/questions?source=${WIKIDATA_SOURCE_ID}&limit=1`);
    expect(q.body.total).toBeGreaterThan(0);
    const detail = await call(`/questions/${q.body.items[0].id}`);
    expect(detail.body.facts[0].sourceId).toBe(WIKIDATA_SOURCE_ID);
    expect(detail.body.facts[0].evidence.recordType).toBe('wd_club_players');
  });

  it('production boot opens the port before the question bank is built', async () => {
    const app = await createApp(
      loadConfig({ LOG_LEVEL: 'silent', ADMIN_TOKEN: 'admin-test-token' } as NodeJS.ProcessEnv),
      {
        log: pino({ level: 'silent' }),
        deferContentInit: true,
      },
    );
    apps.push(app);
    const port = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${port}`;
    const first = (await (await fetch(`${base}/healthz`)).json()) as { ok: boolean; contentReady: boolean };
    expect(first.ok).toBe(true);
    if (!first.contentReady) {
      const r = await fetch(`${base}/api/admin/summary`, {
        headers: { authorization: 'Bearer admin-test-token' },
      });
      expect(r.status).toBe(503);
    }
    const start = Date.now();
    while (!app.content.ready && Date.now() - start < 20_000) await new Promise((r) => setTimeout(r, 50));
    expect(app.content.ready).toBe(true);
    const modes = (await (await fetch(`${base}/api/modes`)).json()) as {
      availability: Record<string, unknown>;
    };
    expect(Object.keys(modes.availability).length).toBeGreaterThan(0);
  });
});
