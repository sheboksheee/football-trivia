import { useEffect, useMemo, useState } from 'react';
import { MODES, MODE_KEYS, PRESET_SIZES, type ModeKey } from '@ft/shared';
import type { RoomView } from '@ft/game-rules';
import { useI18n } from '../i18n.js';
import { client } from '../net/client.js';
import { Avatar, Banner } from '../ui/common.js';

type Preset = 'SINGLE' | 'QUICK' | 'CLASSIC' | 'MARATHON' | 'CUSTOM';
const PRESETS: Array<{ key: Preset; label: string; size: string }> = [
  { key: 'SINGLE', label: 'Single mode', size: '1' },
  { key: 'QUICK', label: 'Quick Match', size: '3' },
  { key: 'CLASSIC', label: 'Classic Night', size: '5' },
  { key: 'MARATHON', label: 'Full Marathon', size: '12' },
  { key: 'CUSTOM', label: 'Custom', size: '2–12' },
];

function presetValid(p: Preset, modes: ModeKey[]): string | null {
  if (p === 'SINGLE') return modes.length === 1 ? null : 'Pick exactly 1 mode';
  if (p === 'CUSTOM') return modes.length >= 2 && modes.length <= 12 ? null : 'Pick 2–12 modes';
  if (p === 'MARATHON') return 'Full Marathon needs all 12 modes; Who Am I? is awaiting approved rules';
  const n = PRESET_SIZES[p];
  return modes.length === n ? null : `Pick exactly ${n} modes (${modes.length} selected)`;
}

export function Lobby({ view }: { view: RoomView }) {
  const { t } = useI18n();
  const me = view.me;
  const isHost = !!me?.isHost;
  const players = view.members.filter((m) => m.role === 'PLAYER');
  const judges = view.members.filter((m) => m.role === 'JUDGE');
  const [preset, setPreset] = useState<Preset>(view.room.playlist.preset as Preset);
  const [modes, setModes] = useState<ModeKey[]>(view.room.playlist.modes);
  const [copied, setCopied] = useState(false);
  const [availability, setAvailability] = useState<Record<string, { published: number }> | null>(null);
  const dirty = preset !== view.room.playlist.preset || modes.join() !== view.room.playlist.modes.join();

  useEffect(() => {
    if (!dirty) {
      setPreset(view.room.playlist.preset as Preset);
      setModes(view.room.playlist.modes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only when the server playlist changes
  }, [view.room.playlist.preset, view.room.playlist.modes.join()]);

  useEffect(() => {
    let alive = true;
    fetch('/api/modes')
      .then((r) => r.json())
      .then((d) => alive && setAvailability(d.availability))
      .catch(() => alive && setAvailability(null));
    return () => {
      alive = false;
    };
  }, []);

  const invalid = presetValid(preset, modes);
  const link = `${location.origin}/#/join/${view.room.code}`;
  const minutes = useMemo(
    () => view.room.playlist.modes.reduce((a, k) => a + MODES[k].estimatedMinutes, 0),
    [view.room.playlist.modes],
  );

  const toggle = (k: ModeKey) => {
    if (!isHost || MODES[k].rulesStatus === 'BLOCKED') return;
    setModes((cur) =>
      preset === 'SINGLE' ? [k] : cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
    );
  };
  const apply = () =>
    client.send(
      { type: 'room.configure', payload: { preset, modes } },
      { expectedVersion: view.room.version },
    );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the code is still visible */
    }
  };
  const myReady = view.members.find((m) => m.id === me?.memberId)?.ready;

  return (
    <div className="grid-2">
      <div className="stack">
        <section className="card pitch" style={{ textAlign: 'center' }}>
          <div className="eyebrow">{t('shareCode')}</div>
          <div className="bigcode" aria-label={`Room code ${view.room.code.split('').join(' ')}`}>
            {view.room.code}
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
            <button className="btn sm" onClick={copy}>
              {copied ? t('copied') : t('copy')}
            </button>
            <span className="badge">{view.room.status === 'READY_CHECK' ? 'Ready check' : t('lobby')}</span>
          </div>
        </section>

        <section className="card">
          <h2 className="display h3 card-title">
            {t('playlist')}{' '}
            {!isHost && (
              <span className="small muted" style={{ textTransform: 'none', fontFamily: 'var(--font-body)' }}>
                · set by the host · ~{minutes} min
              </span>
            )}
          </h2>
          {isHost && (
            <div
              className="seg"
              role="group"
              aria-label="Preset"
              style={{ marginBottom: 12, overflowX: 'auto' }}
            >
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  aria-pressed={preset === p.key}
                  onClick={() => {
                    setPreset(p.key);
                    if (p.key === 'SINGLE') setModes((m) => m.slice(0, 1));
                  }}
                >
                  {p.label} <span className="muted small">{p.size}</span>
                </button>
              ))}
            </div>
          )}
          <div className="modes">
            {MODE_KEYS.map((k) => {
              const m = MODES[k];
              const order = modes.indexOf(k);
              const blocked = m.rulesStatus === 'BLOCKED';
              const published = availability?.[k]?.published;
              const tooFew = players.length < m.minPlayers;
              const noJudge = m.judge === 'required' && judges.length === 0;
              if (!isHost && order < 0) return null;
              return (
                <button
                  key={k}
                  className="modecard"
                  aria-pressed={order >= 0}
                  disabled={!isHost || blocked}
                  onClick={() => toggle(k)}
                  title={blocked ? m.blockers.join(' ') : m.rules}
                >
                  {order >= 0 && <span className="order">{order + 1}</span>}
                  <span className="name">{m.name.en}</span>
                  <span className="small muted">{m.concept}</span>
                  <span className="row" style={{ gap: 6, marginTop: 'auto' }}>
                    <span
                      className={`badge ${m.rulesStatus === 'APPROVED' ? 'ok' : m.rulesStatus === 'PROVISIONAL' ? 'warn' : 'bad'}`}
                    >
                      {m.rulesStatus === 'APPROVED'
                        ? t('rulesApproved')
                        : m.rulesStatus === 'PROVISIONAL'
                          ? t('rulesProvisional')
                          : t('rulesBlocked')}
                    </span>
                    {m.judge === 'required' && (
                      <span className={`badge ${noJudge ? 'bad' : 'info'}`}>⚖ {t('needsJudge')}</span>
                    )}
                    {m.minPlayers > 2 && (
                      <span className={`badge ${tooFew ? 'bad' : ''}`}>
                        {m.minPlayers}+ {t('minPlayers')}
                      </span>
                    )}
                    {published !== undefined && !blocked && published < 5 && (
                      <span className="badge warn">{published} items</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {isHost && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className={`small ${invalid ? 'field-error' : 'muted'}`}>
                {invalid ?? `${modes.length} mode(s) selected`}
              </span>
              <span className="spacer" />
              <button className="btn" disabled={!dirty || !!invalid} onClick={apply}>
                Save playlist
              </button>
            </div>
          )}
        </section>
      </div>

      <div className="stack">
        <section className="card">
          <h2 className="display h3 card-title">
            {t('players')} <span className="muted">{players.length}/6</span>
          </h2>
          <ul className="list">
            {players.map((p) => (
              <li key={p.id} className="list-item">
                <Avatar id={p.id} name={p.name} />
                <span className="grow truncate">
                  {p.name} {p.id === me?.memberId && <span className="muted small">(you)</span>}
                </span>
                {p.id === view.room.hostId && <span className="badge info">{t('host')}</span>}
                {p.id === view.room.coHostId && <span className="badge">{t('coHost')}</span>}
                {!p.connected && <span className="badge bad">{t('disconnected')}</span>}
                <span className={`badge ${p.ready ? 'ok' : ''}`}>
                  {p.ready ? `✓ ${t('ready')}` : t('notReady')}
                </span>
              </li>
            ))}
          </ul>
          {judges.length > 0 && (
            <>
              <div className="eyebrow" style={{ margin: '14px 0 8px' }}>
                {t('judges')}
              </div>
              <ul className="list">
                {judges.map((j) => (
                  <li key={j.id} className="list-item">
                    <Avatar id={j.id} name={j.name} />
                    <span className="grow">{j.name}</span>
                    <span className="badge info">⚖ {t('judge')}</span>
                    {!j.connected && <span className="badge bad">{t('disconnected')}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="small muted">
            👁 {view.spectatorCount} {t('spectators')}
          </p>
          {isHost && players.length > 1 && (
            <div className="field">
              <label className="label" htmlFor="cohost">
                {t('coHost')} (takes over if you disconnect)
              </label>
              <select
                id="cohost"
                className="select"
                value={view.room.coHostId ?? ''}
                onChange={(e) =>
                  client.send({
                    type: 'room.configure',
                    payload: {
                      preset: view.room.playlist.preset as Preset,
                      modes: view.room.playlist.modes,
                      coHostId: e.target.value || null,
                    },
                  })
                }
              >
                <option value="">None — longest-present player</option>
                {players
                  .filter((p) => p.id !== me?.memberId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </section>

        <section className="card stack">
          {me?.role === 'PLAYER' && (
            <button
              className={`btn block ${myReady ? '' : 'primary'}`}
              onClick={() => client.send({ type: 'room.ready', payload: { ready: !myReady } })}
            >
              {myReady ? t('cancelReady') : t('imReady')}
            </button>
          )}
          {view.startIssues.length > 0 && (
            <ul className="list" aria-label="Before kick-off">
              {view.startIssues.map((s) => (
                <li key={s} className="small muted">
                  • {s}
                </li>
              ))}
            </ul>
          )}
          {isHost ? (
            <div className="row">
              {view.room.status === 'LOBBY' && (
                <button
                  className="btn"
                  onClick={() =>
                    client.send(
                      { type: 'room.readyCheck', payload: {} },
                      { expectedVersion: view.room.version },
                    )
                  }
                >
                  {t('readyCheck')}
                </button>
              )}
              <span className="spacer" />
              <button
                className="btn primary"
                disabled={view.startIssues.length > 0 || dirty}
                onClick={() =>
                  client.send({ type: 'room.start', payload: {} }, { expectedVersion: view.room.version })
                }
              >
                {t('start')}
              </button>
            </div>
          ) : (
            <Banner>{me?.role === 'SPECTATOR' ? t('spectating') : t('waitingHost')}</Banner>
          )}
          {MODES.who_am_i && view.room.playlist.modes.some((k) => MODES[k].rulesStatus === 'PROVISIONAL') && (
            <p className="small muted" style={{ margin: 0 }}>
              Provisional modes use proposed parameters pending product approval (see How to play).
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
