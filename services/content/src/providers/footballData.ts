/**
 * football-data.org API v4 adapter.
 * Verified against the official documentation (docs.football-data.org, 2026-11-08):
 *  - base URL https://api.football-data.org/v4, auth header `X-Auth-Token`
 *  - /competitions/{code}/matches?season=YYYY, /competitions/{code}/standings?season=YYYY,
 *    /competitions/{code}/teams?season=YYYY
 *  - free plan: 10 requests/minute (policies page). Line-ups/scorers/squads are paid-plan data.
 * Every response is stored as an immutable RawSnapshot with a sha256 hash (provenance).
 */
import { NOT_SUPPORTED, type ProviderAdapter } from '../adapter.js';
import { snapshot } from '../fixture.js';
import type { RawSnapshot } from '../model.js';
import { FOOTBALL_DATA_SOURCE_ID } from '../sources.js';

export const FD_BASE_URL = 'https://api.football-data.org/v4';
/** Competitions included in the free plan (TIER_ONE in GET /v4/competitions). */
export const FD_FREE_COMPETITIONS = [
  'PL',
  'PD',
  'SA',
  'BL1',
  'FL1',
  'CL',
  'DED',
  'PPL',
  'ELC',
  'BSA',
  'WC',
  'EC',
] as const;

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface FdClientOptions {
  /** Token. Optional: in managed environments a proxy may inject the header instead. */
  token?: string;
  fetch?: FetchLike;
  /** Minimum spacing between requests (free plan: 10/min → 6.5s keeps us safely under). */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRetries?: number;
}

export type FdResult =
  | { ok: true; snapshot: RawSnapshot }
  | {
      ok: false;
      status: number;
      reason: 'NOT_IN_PLAN' | 'NOT_FOUND' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'NETWORK' | 'ERROR';
      url: string;
      detail?: string;
    };

export class FootballDataClient {
  private last = 0;
  private readonly f: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly calls: string[] = [];

  constructor(private readonly o: FdClientOptions = {}) {
    this.f = o.fetch ?? ((url, init) => fetch(url, init) as never);
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = o.now ?? Date.now;
  }

  private async get(path: string, recordType: string, externalId: string): Promise<FdResult> {
    const url = `${FD_BASE_URL}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.o.token) headers['X-Auth-Token'] = this.o.token;
    const retries = this.o.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + (this.o.minIntervalMs ?? 6500) - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      this.calls.push(url);
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.f(url, { headers });
      } catch (e) {
        // DNS/TLS/connection failure: report it instead of crashing the ingestion run.
        return {
          ok: false,
          status: 0,
          reason: 'NETWORK',
          url,
          detail:
            e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : 'network error',
        };
      }
      if (res.status === 200) {
        const body = await res.json();
        return {
          ok: true,
          snapshot: snapshot(
            FOOTBALL_DATA_SOURCE_ID,
            recordType,
            externalId,
            body,
            new Date(this.now()).toISOString(),
          ),
        };
      }
      if (res.status === 429 && attempt < retries) {
        // Documented response header: seconds until the request counter resets.
        const reset = Number(res.headers.get('X-RequestCounter-Reset') ?? '60');
        await this.sleep(Math.max(1, Number.isFinite(reset) ? reset : 60) * 1000);
        continue;
      }
      // An anonymous 403 means the token is missing or invalid (observed: X-Authenticated-Client: anonymous).
      const anonymous = (res.headers.get('X-Authenticated-Client') ?? '').toLowerCase() === 'anonymous';
      const reason =
        res.status === 403 && anonymous
          ? 'UNAUTHORIZED'
          : res.status === 403
            ? 'NOT_IN_PLAN'
            : res.status === 404
              ? 'NOT_FOUND'
              : res.status === 401
                ? 'UNAUTHORIZED'
                : res.status === 429
                  ? 'RATE_LIMITED'
                  : 'ERROR';
      return { ok: false, status: res.status, reason, url };
    }
  }

  competitions() {
    return this.get('/competitions', 'fd_competitions', 'all');
  }
  matches(code: string, season: number) {
    return this.get(
      `/competitions/${encodeURIComponent(code)}/matches?season=${season}`,
      'fd_matches',
      `${code}_${season}`,
    );
  }
  standings(code: string, season: number) {
    return this.get(
      `/competitions/${encodeURIComponent(code)}/standings?season=${season}`,
      'fd_standings',
      `${code}_${season}`,
    );
  }
  teams(code: string, season: number) {
    return this.get(
      `/competitions/${encodeURIComponent(code)}/teams?season=${season}`,
      'fd_teams',
      `${code}_${season}`,
    );
  }
}

export interface IngestReport {
  snapshots: RawSnapshot[];
  skipped: Array<{ url: string; status: number; reason: string; detail?: string }>;
  calls: number;
}

/**
 * Pulls matches, final standings and teams for each competition/season. Calls the API only for
 * records not already in `have` (immutable snapshots are never re-fetched unless `refresh`).
 */
export async function ingestFootballData(
  client: FootballDataClient,
  opts: {
    competitions: string[];
    seasons: number[];
    have?: Set<string>;
    refresh?: boolean;
    onProgress?: (msg: string) => void;
  },
): Promise<IngestReport> {
  const out: RawSnapshot[] = [];
  const skipped: IngestReport['skipped'] = [];
  for (const code of opts.competitions) {
    for (const season of opts.seasons) {
      for (const kind of ['matches', 'standings', 'teams'] as const) {
        const id = `snap_${FOOTBALL_DATA_SOURCE_ID}_fd_${kind}_${code}_${season}`;
        if (!opts.refresh && opts.have?.has(id)) continue;
        const r = await client[kind](code, season);
        if (r.ok) out.push(r.snapshot);
        else {
          skipped.push({
            url: r.url,
            status: r.status,
            reason: r.reason,
            ...(r.detail ? { detail: r.detail } : {}),
          });
          if (r.reason === 'UNAUTHORIZED' || r.reason === 'NETWORK')
            return { snapshots: out, skipped, calls: client.calls.length };
          if (r.reason === 'NOT_IN_PLAN') break; // whole competition-season unavailable on this plan
        }
        opts.onProgress?.(`${code} ${season} ${kind}: ${r.ok ? 'ok' : r.reason}`);
      }
    }
  }
  return { snapshots: out, skipped, calls: client.calls.length };
}

/** ProviderAdapter contract view (Blueprint B2). Player-level data is a paid-plan feature. */
export function footballDataAdapter(
  client: FootballDataClient,
  competitions: string[],
  seasons: number[],
): ProviderAdapter {
  const collect = async (kind: 'matches' | 'standings' | 'teams') => {
    const out: RawSnapshot[] = [];
    for (const c of competitions)
      for (const s of seasons) {
        const r = await client[kind](c, s);
        if (r.ok) out.push(r.snapshot);
      }
    return out;
  };
  return {
    sourceId: FOOTBALL_DATA_SOURCE_ID,
    fetchMatches: () => collect('matches'),
    fetchLineups: async () => NOT_SUPPORTED,
    fetchPlayerStats: async () => NOT_SUPPORTED,
    fetchTeamStats: () => collect('standings'),
    fetchTransfers: async () => NOT_SUPPORTED,
    fetchCompetitionMetadata: async () => {
      const r = await client.competitions();
      return r.ok ? [r.snapshot] : [];
    },
    fetchEntityAliases: () => collect('teams'),
    healthCheck: async () => {
      const r = await client.competitions();
      return r.ok
        ? { ok: true, detail: 'football-data.org reachable' }
        : { ok: false, detail: `HTTP ${r.status} (${r.reason})` };
    },
  };
}
