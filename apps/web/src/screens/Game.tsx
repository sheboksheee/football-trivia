import { useState } from 'react';
import { MODES, type AppealReason, type ModeKey } from '@ft/shared';
import type { RoomView } from '@ft/game-rules';
import { useI18n } from '../i18n.js';
import { modeCopy, modeName } from '../modeText.js';
import { client } from '../net/client.js';
import { useGame, useRemaining } from '../net/hooks.js';
import { ModeView } from '../modes/ModeViews.js';
import { Avatar, Banner, formatPoints, memberNames, Modal, Timer } from '../ui/common.js';

type MN = NonNullable<RoomView['matchNight']>;

const REASONS: AppealReason[] = [
  'ANSWER_SHOULD_BE_ACCEPTED',
  'QUESTION_INCORRECT',
  'QUESTION_AMBIGUOUS',
  'TECHNICAL_ISSUE',
];

export function Game({ view }: { view: RoomView }) {
  const { t, locale } = useI18n();
  const mn = view.matchNight!;
  const me = view.me;
  const role = me?.role ?? 'SPECTATOR';
  const runKey = mn.runKey;
  return (
    <div className="stack">
      <div className="row">
        <span className="eyebrow">
          {t('matchNight')} ·{' '}
          {mn.phase === 'TIEBREAK' || mn.phase === 'FINAL'
            ? t('final')
            : t('modeOf', { i: mn.index + 1, n: mn.modes.length })}
        </span>
        <span className="spacer" />
        {role === 'SPECTATOR' && <span className="badge">👁 {t('spectatingBadge')}</span>}
        {role === 'JUDGE' && <span className="badge info">⚖ {t('judgeBadge')}</span>}
        {me?.forfeited && <span className="badge bad">{t('forfeited')}</span>}
      </div>
      <ClockBanners view={view} />
      {me?.isHost && mn.phase !== 'FINAL' && <HostControls view={view} />}
      <div className="game-grid">
        <section className="card stage-card" aria-label={runKey ? modeName(runKey, locale) : ''}>
          {mn.phase === 'INTRO' && runKey && runKey !== 'tiebreak' && (
            <Intro mn={mn} isHost={!!me?.isHost} frozen={view.clock.frozen} />
          )}
          {(mn.phase === 'PLAYING' || mn.phase === 'TIEBREAK') && mn.view !== null && runKey && (
            <>
              {mn.phase === 'TIEBREAK' && <TiebreakHead mn={mn} />}
              <ModeView
                runKey={runKey}
                v={mn.view}
                me={role === 'SPECTATOR' ? null : (me?.memberId ?? null)}
                role={role}
                players={mn.runPlayers}
              />
            </>
          )}
          {mn.phase === 'RESULTS' && <ModeResults mn={mn} isHost={!!me?.isHost} frozen={view.clock.frozen} />}
          {mn.phase === 'FINAL' && <Final mn={mn} />}
        </section>
        <aside className="stack side">
          <Appeals view={view} />
          <Standings mn={mn} />
        </aside>
      </div>
    </div>
  );
}

function ClockBanners({ view }: { view: RoomView }) {
  const { t } = useI18n();
  const names = memberNames(view);
  const out = [];
  if (view.room.status === 'SUSPENDED')
    out.push(
      <Banner key="s" tone="bad">
        {t('suspended')}
      </Banner>,
    );
  if (view.pause)
    out.push(
      <Banner key="p" tone="warn" icon="⏸">
        {view.pause.emergency
          ? t('pausedEmergency', { reason: view.pause.reason ?? '' })
          : t('pausedBetween')}
      </Banner>,
    );
  else if (view.clock.reasons.includes('APPEAL'))
    out.push(
      <Banner key="a" tone="warn" icon="⚖">
        {t('holdAppeal')}
      </Banner>,
    );
  if (view.pausePending)
    out.push(
      <Banner key="pp" tone="info">
        {t('pausePending')}
      </Banner>,
    );
  if (view.room.hostGraceUntil)
    out.push(
      <Banner key="h" tone="warn">
        {t('hostAway', { name: names[view.room.hostId] ?? '' })}
      </Banner>,
    );
  return <>{out}</>;
}

function HostControls({ view }: { view: RoomView }) {
  const { t } = useI18n();
  const [emergency, setEmergency] = useState(false);
  const [reason, setReason] = useState('');
  const mn = view.matchNight!;
  const paused = !!view.pause;
  return (
    <div className="row host-bar">
      <span className="eyebrow">{t('host')}</span>
      {!paused && !view.pausePending && (
        <button
          className="btn sm"
          onClick={() => client.send({ type: 'room.pause', payload: { emergency: false } })}
        >
          {t('pause')}
        </button>
      )}
      {!paused && (
        <button className="btn sm danger" onClick={() => setEmergency(true)}>
          {t('emergencyPause')}
        </button>
      )}
      {(paused || view.pausePending) && (
        <button className="btn sm primary" onClick={() => client.send({ type: 'room.resume', payload: {} })}>
          {paused ? t('resume') : t('cancel')}
        </button>
      )}
      {(mn.phase === 'INTRO' || mn.phase === 'RESULTS') && !paused && (
        <button className="btn sm" onClick={() => client.send({ type: 'room.nextMode', payload: {} })}>
          {t('skip')}
        </button>
      )}
      {emergency && (
        <Modal title={t('emergencyPause')} onClose={() => setEmergency(false)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const ack = await client.send({ type: 'room.pause', payload: { emergency: true, reason } });
              if (ack.ok) {
                setEmergency(false);
                setReason('');
              }
            }}
          >
            <p className="muted" style={{ margin: 0 }}>
              {t('emergencyHelp')}
            </p>
            <div className="field">
              <label className="label" htmlFor="reason">
                {t('reason')}
              </label>
              <input
                id="reason"
                className="input"
                dir="auto"
                value={reason}
                minLength={3}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </div>
            <div className="row">
              <span className="spacer" />
              <button type="button" className="btn ghost" onClick={() => setEmergency(false)}>
                {t('cancel')}
              </button>
              <button className="btn danger" disabled={reason.trim().length < 3}>
                {t('confirm')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Intro({ mn, isHost, frozen }: { mn: MN; isHost: boolean; frozen: boolean }) {
  const { t, locale } = useI18n();
  const key = mn.runKey as ModeKey;
  const m = MODES[key];
  const copy = modeCopy(key, locale);
  const names = memberNames(useGame().view);
  const rem = useRemaining(mn.phaseEnd);
  return (
    <div className="stage">
      <div className="eyebrow">{t('upNext', { n: m.number })}</div>
      <h2 className="display h2">{copy.name}</h2>
      <p style={{ margin: 0 }}>{copy.concept}</p>
      <div className="card tight" style={{ background: 'var(--bg-2)' }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>
          {t('rulesScoring')}
        </div>
        <p style={{ margin: 0 }}>{copy.rules}</p>
        {copy.proposed.length > 0 && (
          <details style={{ marginTop: 8 }}>
            <summary className="small">
              <span className="badge warn">{t('provisional')}</span> {t('provisionalParams')}
            </summary>
            <ul className="small muted">
              {copy.proposed.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="row">
        {mn.runPlayers.map((p) => (
          <span key={p} className="row" style={{ gap: 6 }}>
            <Avatar id={p} name={names[p] ?? '?'} size={28} />
            {names[p]}
          </span>
        ))}
      </div>
      <Timer end={mn.phaseEnd} start={mn.phaseEnd !== null ? mn.phaseEnd - 10_000 : null} />
      {!isHost && (
        <p className="small muted" style={{ margin: 0 }}>
          {frozen ? t('pausedShort') : t('startingIn', { s: Math.ceil((rem ?? 0) / 1000) })}
        </p>
      )}
    </div>
  );
}

function TiebreakHead({ mn }: { mn: MN }) {
  const { t } = useI18n();
  const names = memberNames(useGame().view);
  return (
    <Banner tone="warn" icon="🏆">
      {t('tiebreakIntro', { names: (mn.tiebreakTied ?? []).map((m) => names[m]).join('، ') })}
    </Banner>
  );
}

function ModeResults({ mn, isHost, frozen }: { mn: MN; isHost: boolean; frozen: boolean }) {
  const r = mn.results[mn.results.length - 1];
  const names = memberNames(useGame().view);
  const { t, locale } = useI18n();
  if (!r) return null;
  const pos: Record<string, number> = {};
  let p = 0;
  for (const g of r.groups) {
    for (const m of g) pos[m] = p + 1;
    p += g.length;
  }
  return (
    <div className="stage">
      <div className="eyebrow">{t('results')}</div>
      <h2 className="display h2">{modeName(r.key, locale)}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('rank')}</th>
              <th>{t('player_col')}</th>
              <th>{t('native')}</th>
              <th>{t('matchNightPts')}</th>
            </tr>
          </thead>
          <tbody>
            {r.groups.flat().map((m) => (
              <tr key={m}>
                <td className="rank">
                  {pos[m]}
                  {r.groups.find((g) => g.includes(m))!.length > 1 ? '=' : ''}
                </td>
                <td>
                  <span className="row" style={{ flexWrap: 'nowrap' }}>
                    <Avatar id={m} name={names[m] ?? '?'} size={28} />
                    {names[m]}
                  </span>
                </td>
                <td className="num" dir="ltr">
                  {formatPoints(r.scores[m])}
                </td>
                <td className="num accent" dir="ltr">
                  +{formatPoints(r.placement[m])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {t('placementNote')}
      </p>
      <Timer
        end={mn.phaseEnd}
        start={mn.phaseEnd !== null ? mn.phaseEnd - 15_000 : null}
        label={t('nextModeIn')}
      />
      {!isHost && frozen && <p className="small muted">{t('pausedByHost')}</p>}
    </div>
  );
}

function Standings({ mn }: { mn: MN }) {
  const names = memberNames(useGame().view);
  const { t, locale } = useI18n();
  const done = mn.results.filter((r) => !r.skipped).length;
  return (
    <section className="card">
      <h2 className="display h3 card-title">{t('standings')}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('rank')}</th>
              <th>{t('player_col')}</th>
              <th>{t('pts')}</th>
              <th title={t('soleFinishes')}>1·2·3</th>
            </tr>
          </thead>
          <tbody>
            {mn.standings.map((s, i) => (
              <tr key={s.memberId}>
                <td className="rank">{i + 1}</td>
                <td className="truncate" style={{ maxWidth: 140 }}>
                  {names[s.memberId]}
                </td>
                <td className="num accent" title={s.points} dir="ltr">
                  {s.display}
                </td>
                <td className="small muted" dir="ltr">
                  {s.sole1}·{s.sole2}·{s.sole3}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        {t('modesScored', { done, n: mn.modes.length })}
      </p>
      {mn.results
        .filter((r) => r.skipped)
        .map((r) => (
          <p key={r.key} className="small" style={{ color: 'var(--warn)' }}>
            {t('skippedBecause', { mode: modeName(r.key, locale), reason: t('skippedReason') })}
          </p>
        ))}
    </section>
  );
}

function Final({ mn }: { mn: MN }) {
  const f = mn.final!;
  const names = memberNames(useGame().view);
  const { t, locale } = useI18n();
  const shared = f.champions.length > 1;
  return (
    <div className="stage">
      <div className="card champ">
        <div className="trophy" aria-hidden="true">
          🏆
        </div>
        <div className="eyebrow">{shared ? t('champions') : t('champion')}</div>
        <h2 className="display h1" style={{ fontSize: 'clamp(38px, 10vw, 64px)' }}>
          {f.champions.map((c) => names[c]).join(' & ')}
        </h2>
        {f.tiebreakUsed && <p className="muted">{shared ? t('stillLevel') : t('decidedTiebreak')}</p>}
      </div>
      <div className="eyebrow">{t('modeBreakdown')}</div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('modeCol')}</th>
              {mn.participants.map((p) => (
                <th key={p}>{names[p]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mn.results.map((r) => (
              <tr key={r.key}>
                <td>
                  {modeName(r.key, locale)}
                  {r.skipped && (
                    <span className="badge warn" style={{ marginInlineStart: 6 }}>
                      {t('skipped')}
                    </span>
                  )}
                </td>
                {mn.participants.map((p) => (
                  <td key={p} className="num" dir="ltr">
                    {r.skipped || r.placement[p] === undefined ? '—' : formatPoints(r.placement[p])}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td>
                <strong>{t('total')}</strong>
              </td>
              {mn.participants.map((p) => (
                <td key={p} className="num accent" dir="ltr">
                  {formatPoints(f.standings.find((s) => s.memberId === p)?.points)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <button
        className="btn"
        onClick={() => {
          void client.leave();
          location.hash = '#/';
        }}
      >
        {t('newGame')}
      </button>
    </div>
  );
}

function Appeals({ view }: { view: RoomView }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const [reason, setReason] = useState<AppealReason>('ANSWER_SHOULD_BE_ACCEPTED');
  const [note, setNote] = useState('');
  const names = memberNames(view);
  const isJudge = view.me?.role === 'JUDGE';
  const win = view.appealWindows[0];
  const rem = useRemaining(win?.closesAt);
  const mine = view.appeals.filter((a) => a.mine);
  const toResolve = view.appeals.filter((a) => a.canResolve);
  const statusText = (s: string) => t(`status_${s}` as 'status_PENDING');
  if (!win && mine.length === 0 && !isJudge && view.appeals.length === 0) return null;
  return (
    <section className="card stack">
      <h2 className="display h3 card-title">⚖ {isJudge ? t('judging') : t('appeals')}</h2>
      {win && (
        <button className="btn block" onClick={() => setOpen(win.itemIndex)}>
          {t('appealIn', { s: Math.ceil((rem ?? 0) / 1000) })}
        </button>
      )}
      {mine.map((a) => (
        <div key={a.id} className="list-item small">
          <span className="grow">{t('yourAppeal', { n: a.itemIndex + 1 })}</span>
          <span
            className={`badge ${a.status === 'PENDING' ? 'warn' : a.status === 'ACCEPTED' ? 'ok' : 'bad'}`}
          >
            {statusText(a.status)}
          </span>
        </div>
      ))}
      {isJudge && toResolve.length === 0 && (
        <p className="small muted" style={{ margin: 0 }}>
          {t('noAppeals')}
        </p>
      )}
      {isJudge &&
        toResolve.map((a) => (
          <ResolveAppeal
            key={a.id}
            a={a}
            name={names[a.claimantId] ?? '?'}
            isTop25={view.matchNight?.runKey === 'top25'}
          />
        ))}
      {view.appeals
        .filter((a) => !a.mine && !a.canResolve && a.status !== 'PENDING')
        .map((a) => (
          <p key={a.id} className="small muted" style={{ margin: 0 }}>
            {t('othersAppeal', {
              name: names[a.claimantId] ?? '',
              n: a.itemIndex + 1,
              status: statusText(a.status),
            })}
            {a.decisionNote ? ` — ${a.decisionNote}` : ''}
          </p>
        ))}
      {open !== null && (
        <Modal title={t('appealOpen')} onClose={() => setOpen(null)}>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              const ack = await client.send({
                type: 'appeal.open',
                payload: { questionIndex: open, reason, ...(note.trim() ? { note: note.trim() } : {}) },
              });
              if (ack.ok) setOpen(null);
            }}
          >
            <p className="muted small" style={{ margin: 0 }}>
              {t('appealHelp')}
            </p>
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label">{t('appealReason')}</legend>
              {REASONS.map((r) => (
                <label key={r} className="list-item" style={{ cursor: 'pointer' }}>
                  <input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} />{' '}
                  {t(`reason_${r}` as 'reason_TECHNICAL_ISSUE')}
                </label>
              ))}
            </fieldset>
            <textarea
              className="textarea"
              dir="auto"
              maxLength={280}
              placeholder={t('appealNote')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="row">
              <span className="spacer" />
              <button type="button" className="btn ghost" onClick={() => setOpen(null)}>
                {t('cancel')}
              </button>
              <button className="btn primary">{t('appeal')}</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

function ResolveAppeal({
  a,
  name,
  isTop25,
}: {
  a: RoomView['appeals'][number];
  name: string;
  isTop25: boolean;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  const [rank, setRank] = useState('');
  const send = (decision: 'ACCEPT' | 'REJECT' | 'VOID') =>
    client.send({
      type: 'appeal.resolve',
      payload: {
        appealId: a.id,
        decision,
        note: note.trim(),
        ...(decision === 'ACCEPT' && isTop25 && rank ? { detail: Number(rank) } : {}),
      },
    });
  const ok = note.trim().length >= 3;
  return (
    <div className="card tight stack" style={{ background: 'var(--bg-2)' }}>
      <div>
        <strong>{name}</strong> · {t('question')} {a.itemIndex + 1} ·{' '}
        {t(`reason_${a.reason}` as 'reason_TECHNICAL_ISSUE')}
      </div>
      {a.note && (
        <div className="small muted" dir="auto">
          «{a.note}»
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>
        {t('judgeReview')}
      </p>
      {isTop25 && (
        <input
          className="input"
          inputMode="numeric"
          placeholder={t('top25Rank')}
          value={rank}
          onChange={(e) => setRank(e.target.value.replace(/\D/g, ''))}
        />
      )}
      <input
        className="input"
        dir="auto"
        placeholder={t('decisionNote')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="row">
        <button
          className="btn sm primary"
          disabled={!ok || (isTop25 && !rank)}
          onClick={() => send('ACCEPT')}
        >
          {t('accept')}
        </button>
        <button className="btn sm" disabled={!ok} onClick={() => send('REJECT')}>
          {t('reject')}
        </button>
        <button className="btn sm danger" disabled={!ok} onClick={() => send('VOID')}>
          {t('void')}
        </button>
      </div>
    </div>
  );
}
