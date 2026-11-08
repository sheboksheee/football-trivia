import { useEffect, useMemo, useState } from 'react';
import { MODES, MODE_KEYS, PRESET_SIZES, type ModeKey } from '@ft/shared';
import type { RoomView } from '@ft/game-rules';
import { useI18n, type TFn, type TKey } from '../i18n.js';
import { modeCopy, modeName } from '../modeText.js';
import { client } from '../net/client.js';
import { Avatar, Banner } from '../ui/common.js';

type Preset = 'SINGLE' | 'QUICK' | 'CLASSIC' | 'MARATHON' | 'CUSTOM';
const PRESETS: Array<{ key: Preset; label: TKey; size: string }> = [
  { key: 'SINGLE', label: 'presetSingle', size: '1' },
  { key: 'QUICK', label: 'presetQuick', size: '3' },
  { key: 'CLASSIC', label: 'presetClassic', size: '5' },
  { key: 'MARATHON', label: 'presetMarathon', size: '12' },
  { key: 'CUSTOM', label: 'presetCustom', size: '2–12' },
];

function presetValid(p: Preset, modes: ModeKey[], t: TFn): string | null {
  if (p === 'SINGLE') return modes.length === 1 ? null : t('pickExactly', { n: 1, count: modes.length });
  if (p === 'CUSTOM') return modes.length >= 2 && modes.length <= 12 ? null : t('pickRange');
  if (p === 'MARATHON') return t('marathonBlocked');
  const n = PRESET_SIZES[p];
  return modes.length === n ? null : t('pickExactly', { n, count: modes.length });
}

export function Lobby({ view }: { view: RoomView }) {
  const { t, locale } = useI18n();
  const me = view.me;
  const isHost = !!me?.isHost;
  const players = view.members.filter((m) => m.role === 'PLAYER');
  const judges = view.members.filter((m) => m.role === 'JUDGE');
  const [preset, setPreset] = useState<Preset>(view.room.playlist.preset as Preset);
  const [modes, setModes] = useState<ModeKey[]>(view.room.playlist.modes);
  const [copied, setCopied] = useState(false);
  const [availability, setAvailability] = useState<Record<
    string,
    { published: number; needed?: Record<number, number> }
  > | null>(null);
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

  const invalid = presetValid(preset, modes, t);
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
  const issueText = (i: RoomView['startIssues'][number]) =>
    t(`issue_${i.code}` as TKey, { ...i.params, mode: i.mode ? modeName(i.mode, locale) : '' });

  return (
    <div className="lobby-grid">
      <div className="stack">
        <section className="card pitch code-card">
          <div className="eyebrow">{t('shareCode')}</div>
          <div
            className="bigcode"
            dir="ltr"
            aria-label={`${t('roomCode')} ${view.room.code.split('').join(' ')}`}
          >
            {view.room.code}
          </div>
          <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
            <button className="btn sm" onClick={copy}>
              {copied ? t('copied') : t('copy')}
            </button>
            <span className="badge">
              {view.room.status === 'READY_CHECK' ? t('readyCheckBadge') : t('lobby')}
            </span>
          </div>
        </section>

        <section className="card playlist-card">
          <h2 className="display h3 card-title">
            {t('playlist')}{' '}
            {!isHost && (
              <span className="small muted" style={{ textTransform: 'none', fontFamily: 'var(--font-body)' }}>
                · {t('setByHost', { min: minutes })}
              </span>
            )}
          </h2>
          {isHost && (
            <div className="seg preset-seg" role="group" aria-label={t('playlist')}>
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  aria-pressed={preset === p.key}
                  onClick={() => {
                    setPreset(p.key);
                    if (p.key === 'SINGLE') setModes((m) => m.slice(0, 1));
                  }}
                >
                  {t(p.label)} <span className="muted small">{p.size}</span>
                </button>
              ))}
            </div>
          )}
          <div className="modes">
            {MODE_KEYS.map((k) => {
              const m = MODES[k];
              const c = modeCopy(k, locale);
              const order = modes.indexOf(k);
              const blocked = m.rulesStatus === 'BLOCKED';
              const published = availability?.[k]?.published;
              const need = availability?.[k]?.needed?.[Math.min(6, Math.max(2, players.length))];
              const noContent = published !== undefined && need !== undefined && published < need;
              const tooFew = players.length < m.minPlayers;
              const noJudge = m.judge === 'required' && judges.length === 0;
              if (!isHost && order < 0) return null;
              return (
                <button
                  key={k}
                  className="modecard"
                  aria-pressed={order >= 0}
                  disabled={!isHost || blocked || (noContent && order < 0)}
                  onClick={() => toggle(k)}
                  title={blocked ? c.blockers.join(' ') : c.rules}
                >
                  {order >= 0 && <span className="order">{order + 1}</span>}
                  <span className="name">{c.name}</span>
                  <span className="small muted">{c.concept}</span>
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
                        {t('playersMin', { n: m.minPlayers })}
                      </span>
                    )}
                    {!blocked && noContent && <span className="badge bad">{t('noQuestions')}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          {isHost && (
            <div className="row" style={{ marginTop: 12 }}>
              <span className={`small ${invalid ? 'field-error' : 'muted'}`}>
                {invalid ?? t('selectedCount', { n: modes.length })}
              </span>
              <span className="spacer" />
              <button className="btn" disabled={!dirty || !!invalid} onClick={apply}>
                {t('savePlaylist')}
              </button>
            </div>
          )}
        </section>
      </div>

      <div className="stack side">
        <section className="card players-card">
          <h2 className="display h3 card-title">
            {t('players')}{' '}
            <span className="muted" dir="ltr">
              {players.length}/6
            </span>
          </h2>
          <ul className="list">
            {players.map((p) => (
              <li key={p.id} className="list-item">
                <Avatar id={p.id} name={p.name} />
                <span className="grow truncate">
                  {p.name} {p.id === me?.memberId && <span className="muted small">{t('you')}</span>}
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
          <p className="small muted">👁 {t('spectatorsCount', { n: view.spectatorCount })}</p>
          {isHost && players.length > 1 && (
            <div className="field">
              <label className="label" htmlFor="cohost">
                {t('coHostLabel')}
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
                <option value="">{t('coHostNone')}</option>
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

        <section className="card stack kickoff-card">
          {me?.role === 'PLAYER' && (
            <button
              className={`btn block ${myReady ? '' : 'primary'}`}
              onClick={() => client.send({ type: 'room.ready', payload: { ready: !myReady } })}
            >
              {myReady ? t('cancelReady') : t('imReady')}
            </button>
          )}
          {view.startIssues.length > 0 && (
            <ul className="list" aria-label={t('beforeKickoff')}>
              {view.startIssues.map((s, i) => (
                <li key={i} className="small muted">
                  • {issueText(s)}
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
            <Banner>{me?.role === 'SPECTATOR' || !me ? t('spectating') : t('waitingHost')}</Banner>
          )}
          {view.room.playlist.modes.some((k) => MODES[k].rulesStatus === 'PROVISIONAL') && (
            <p className="small muted" style={{ margin: 0 }}>
              {t('provisionalNote')}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
