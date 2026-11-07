import { NOT_SUPPORTED, type ProviderAdapter } from './adapter.js';
import { fixtureSnapshots, generateLeague } from './fixture.js';
import { SYNTHETIC_SOURCE_ID } from './sources.js';

/** Adapter over the fictional fixture, implementing the provider contract. */
export function syntheticAdapter(): ProviderAdapter {
  const snaps = () => fixtureSnapshots(generateLeague()).filter((s) => s.sourceId === SYNTHETIC_SOURCE_ID);
  const by = (t: string) => async () => snaps().filter((s) => s.recordType === t);
  return {
    sourceId: SYNTHETIC_SOURCE_ID,
    fetchMatches: by('match'),
    fetchLineups: by('match'),
    fetchPlayerStats: by('player_season'),
    fetchTeamStats: async () => NOT_SUPPORTED,
    fetchTransfers: async () => NOT_SUPPORTED,
    fetchCompetitionMetadata: by('competition'),
    fetchEntityAliases: async () => NOT_SUPPORTED,
    healthCheck: async () => ({ ok: true, detail: 'Local deterministic fixture' }),
  };
}
