import type { RawSnapshot } from './model.js';

export const NOT_SUPPORTED = { status: 'NOT_SUPPORTED' } as const;
export type NotSupported = typeof NOT_SUPPORTED;
export type AdapterResult = RawSnapshot[] | NotSupported;

/** Blueprint B2 provider adapter contract. Unsupported methods return NOT_SUPPORTED explicitly. */
export interface ProviderAdapter {
  sourceId: string;
  fetchMatches(): Promise<AdapterResult>;
  fetchLineups(): Promise<AdapterResult>;
  fetchPlayerStats(): Promise<AdapterResult>;
  fetchTeamStats(): Promise<AdapterResult>;
  fetchTransfers(): Promise<AdapterResult>;
  fetchCompetitionMetadata(): Promise<AdapterResult>;
  fetchEntityAliases(): Promise<AdapterResult>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
