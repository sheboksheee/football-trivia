/* eslint-disable @typescript-eslint/no-explicit-any -- engine views are server projections typed per mode below */
import { useState, type FormEvent, type ReactNode } from 'react';
import { client } from '../net/client.js';
import { useGame, useGameNow } from '../net/hooks.js';
import { useI18n } from '../i18n.js';
import { modeName } from '../modeText.js';
import { Attribution, Avatar, Banner, memberNames, ScoreStrip, Timer } from '../ui/common.js';

export interface ModeProps {
  v: any;
  me: string | null;
  role: 'PLAYER' | 'JUDGE' | 'SPECTATOR';
  players: string[];
}

const KEYS = ['A', 'B', 'C', 'D'];

function useNames() {
  const { view } = useGame();
  return memberNames(view);
}

function Head({
  label,
  index,
  count,
  end,
  start,
}: {
  label: string;
  index?: number;
  count?: number;
  end: number | null;
  start?: number | null;
}) {
  const { t } = useI18n();
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <span className="eyebrow">{label}</span>
        <span className="spacer" />
        {index !== undefined && count !== undefined && (
          <span
            className="eyebrow"
            dir="ltr"
            aria-label={`${t('question')} ${index + 1} ${t('of')} ${count}`}
          >
            {index + 1} / {count}
          </span>
        )}
      </div>
      <Timer end={end} start={start ?? null} />
    </div>
  );
}

function Locked({ show, children }: { show: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  if (!show) return null;
  return (
    <Banner tone="info" icon="🔒">
      {children ?? t('submitted')}
    </Banner>
  );
}

function TextAnswer({
  disabled,
  onSubmit,
  placeholder,
  cta,
}: {
  disabled: boolean;
  onSubmit: (s: string) => Promise<unknown>;
  placeholder?: string;
  cta?: string;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    await onSubmit(text.trim());
    setBusy(false);
  };
  return (
    <form className="answer-form" onSubmit={submit}>
      <label className="sr-only" htmlFor="answer">
        {placeholder ?? t('typeAnswer')}
      </label>
      <input
        id="answer"
        className="input"
        autoComplete="off"
        maxLength={80}
        dir="auto"
        value={text}
        disabled={disabled || busy}
        placeholder={placeholder ?? t('typeAnswer')}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="btn primary" disabled={disabled || busy || !text.trim()}>
        {cta ?? t('submit')}
      </button>
    </form>
  );
}

/** Four-option grid; reveal states use colour AND text labels (never colour alone). */
function Options({
  options,
  picked,
  correctId,
  disabled,
  onPick,
}: {
  options: { id: string; label: string }[];
  picked?: string | null;
  correctId?: string | null;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="options" role="group">
      {options.map((o, i) => {
        const isCorrect = correctId && o.id === correctId;
        const isWrongPick = correctId && picked === o.id && o.id !== correctId;
        const cls = isCorrect ? 'correct' : isWrongPick ? 'incorrect' : picked === o.id ? 'picked' : '';
        return (
          <button
            key={o.id}
            className={`option ${cls}`}
            disabled={disabled}
            aria-pressed={picked === o.id}
            onClick={() => onPick(o.id)}
          >
            <span className="key" aria-hidden="true">
              {KEYS[i]}
            </span>
            <span dir="auto">{o.label}</span>
            {isCorrect && <span className="verdict accent">✓ {t('correct')}</span>}
            {isWrongPick && (
              <span className="verdict" style={{ color: 'var(--danger)' }}>
                ✕ {t('wrong')}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function RevealNote({ v, me }: { v: any; me: string | null }) {
  const { t } = useI18n();
  if (v.phase !== 'REVEAL' && v.phase !== 'DONE') return null;
  if (v.voided) return <Banner tone="warn">{t('voided')}</Banner>;
  const mine = me ? v.submissions?.[me] : null;
  if (!mine) return null;
  if (!mine.answered) return <Banner tone="bad">⏱ {t('timeUp')}</Banner>;
  return mine.correct ? (
    <Banner tone="ok" icon="✓">
      {t('correct')}
    </Banner>
  ) : (
    <Banner tone="bad" icon="✕">
      {t('wrong')}
    </Banner>
  );
}

function AnsweredRow({ v, players }: { v: any; players: string[] }) {
  const names = useNames();
  const { t } = useI18n();
  const subs = v.submissions ?? {};
  return (
    <div className="row small muted" aria-label={t('answerStatus')}>
      {(v.eligible ?? players).map((p: string) => (
        <span key={p} className={`badge ${subs[p]?.answered ? 'ok' : ''}`}>
          {subs[p]?.answered ? '✓' : '…'} {names[p]}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Higher or Lower
export function HigherLower({ v, me, role, players }: ModeProps) {
  const { t } = useI18n();
  const it = v.item;
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine && v.eligible.includes(me);
  const send = (choice: string) => client.act({ type: 'answer', choice, itemIndex: v.itemIndex });
  return (
    <div className="stage">
      <Head
        label={it.statLabel}
        index={v.itemIndex}
        count={v.itemCount}
        end={v.phase === 'QUESTION' || v.phase === 'REVEAL' ? v.phaseEnd : null}
        start={v.phaseStart}
      />
      <p className="muted small" style={{ margin: 0 }} dir="auto">
        {it.scope}
      </p>
      <div className="versus">
        <div className="statcard">
          <span className="eyebrow">A</span>
          <strong dir="auto">{it.a.label}</strong>
          <span className="big">{it.a.value}</span>
          <span className="muted small">{it.unit}</span>
        </div>
        <div className="vs">VS</div>
        <div className="statcard" style={it.correct ? { borderColor: 'var(--accent)' } : undefined}>
          <span className="eyebrow">B</span>
          <strong dir="auto">{it.b.label}</strong>
          <span className="big">{it.b.value ?? '?'}</span>
          <span className="muted small">{it.unit}</span>
        </div>
      </div>
      {v.phase === 'QUESTION' && role === 'PLAYER' && (
        <div className="options">
          <button
            className={`option ${mine === 'HIGHER' ? 'picked' : ''}`}
            disabled={!canAnswer}
            onClick={() => send('HIGHER')}
          >
            <span className="key">▲</span> {t('hl_higher')}
          </button>
          <button
            className={`option ${mine === 'LOWER' ? 'picked' : ''}`}
            disabled={!canAnswer}
            onClick={() => send('LOWER')}
          >
            <span className="key">▼</span> {t('hl_lower')}
          </button>
        </div>
      )}
      <Locked show={!!mine && v.phase === 'QUESTION'}>
        {mine === 'HIGHER' ? t('hl_lockedHigher') : t('hl_lockedLower')}
      </Locked>
      {it.correct && (
        <Banner tone="info">{it.correct === 'HIGHER' ? t('hl_answerHigher') : t('hl_answerLower')}</Banner>
      )}
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- MCQ-based: Last Man Standing & tiebreak
export function Mcq({
  v,
  me,
  role,
  players,
  label,
  extra,
}: ModeProps & { label: string; extra?: ReactNode }) {
  const { t } = useI18n();
  const it = v.item;
  const mine = me ? v.submissions?.[me]?.answer : null;
  const eligible = me ? v.eligible.includes(me) : false;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine && eligible;
  return (
    <div className="stage">
      <Head label={label} index={v.itemIndex} count={v.itemCount} end={v.phaseEnd} start={v.phaseStart} />
      {extra}
      <h2 className="prompt" dir="auto">
        {it.prompt}
      </h2>
      <Options
        options={it.options}
        picked={mine}
        correctId={it.correctOptionId}
        disabled={!canAnswer}
        onPick={(id) => client.act({ type: 'answer', optionId: id, itemIndex: v.itemIndex })}
      />
      {role === 'PLAYER' && !eligible && v.phase === 'QUESTION' && (
        <Banner tone="warn">{t('watchingQuestion')}</Banner>
      )}
      <RevealNote v={v} me={me} />
      {it.explanation && (
        <p className="muted" style={{ margin: 0 }} dir="auto">
          {it.explanation}
        </p>
      )}
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
    </div>
  );
}

export function LastManStanding(p: ModeProps) {
  const names = useNames();
  const { t } = useI18n();
  const hearts: Record<string, number> = p.v.extra?.hearts ?? {};
  return (
    <>
      <Mcq
        {...p}
        label={t('lms_label')}
        extra={
          <div className="row" aria-label={t('hearts')}>
            {p.players.map((m) => (
              <span key={m} className={`badge ${hearts[m] ? '' : 'bad'}`}>
                {names[m]} {hearts[m] ? '❤'.repeat(hearts[m]) : t('lms_out')}
                <span className="sr-only">
                  {hearts[m]} {t('hearts')}
                </span>
              </span>
            ))}
          </div>
        }
      />
      {p.v.phase === 'DONE' && <ScoreStrip scores={p.v.scores} players={p.players} />}
    </>
  );
}

// ---------------------------------------------------------------- Missing XI
export function MissingXi({ v, me, role, players }: ModeProps) {
  const { t, locale } = useI18n();
  const it = v.item;
  const now = useGameNow();
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine;
  const nextHintAt = it.hintsViewed < 2 ? v.phaseStart + it.hintTimes[it.hintsViewed] : null;
  const hintReady = nextHintAt !== null && now >= nextHintAt;
  const rows = [it.slots.slice(9, 11), it.slots.slice(5, 9), it.slots.slice(1, 5), it.slots.slice(0, 1)];
  const value = [5, 3, 1][it.hintsViewed] ?? 1;
  return (
    <div className="stage">
      <Head
        label={modeName('missing_xi', locale)}
        index={v.itemIndex}
        count={v.itemCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      <div>
        <h2 className="prompt" dir="auto">
          {it.match}
        </h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          {t('xi_lineup', { date: it.date, team: it.team, formation: it.formation })}
        </p>
      </div>
      <div className="formation" aria-label={it.team} dir="ltr">
        {rows.map((row: any[], i: number) => (
          <div key={i} className="formation-row">
            {row.map((s: any) => (
              <div key={s.slot} className={`shirt ${s.player ? '' : 'missing'}`}>
                <div className="eyebrow" style={{ fontSize: 11 }}>
                  {s.position}
                </div>
                <div>{s.player ?? (it.answer ? it.answer : '?')}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {it.hints.map((h: string, i: number) => (
        <Banner key={i} tone="info" icon="💡">
          <span dir="auto">{h}</span>
        </Banner>
      ))}
      {role === 'PLAYER' && v.phase === 'QUESTION' && !mine && it.hintsViewed < 2 && (
        <button
          className="btn"
          disabled={!hintReady}
          onClick={() => client.act({ type: 'hint', itemIndex: v.itemIndex })}
        >
          {hintReady
            ? t('xi_revealHint', { n: it.hintsViewed + 1, pts: [3, 1][it.hintsViewed]! })
            : t('xi_hintIn', { n: it.hintsViewed + 1, s: Math.ceil((nextHintAt! - now) / 1000) })}
        </button>
      )}
      {role === 'PLAYER' && v.phase === 'QUESTION' && (
        <p className="small muted" style={{ margin: 0 }}>
          {t('xi_oneAnswer', { pts: value })}
        </p>
      )}
      {canAnswer && (
        <TextAnswer
          disabled={!canAnswer}
          onSubmit={(text) => client.act({ type: 'answer', text, itemIndex: v.itemIndex })}
          placeholder={t('xi_placeholder')}
        />
      )}
      <Locked show={!!mine && v.phase === 'QUESTION'}>{t('lockedIn', { answer: mine?.text ?? '' })}</Locked>
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Guess the Match
export function GuessTheMatch({ v, me, role, players }: ModeProps) {
  const { t, locale } = useI18n();
  const it = v.item;
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine;
  const worth = [5, 3, 1][Math.max(0, it.clues.length - 1)] ?? 1;
  return (
    <div className="stage">
      <Head
        label={modeName('guess_the_match', locale)}
        index={v.itemIndex}
        count={v.itemCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      <ol className="list" aria-label={t('clues')}>
        {[0, 1, 2].map((i) => (
          <li key={i} className="list-item">
            <span className="num accent" style={{ fontSize: 22 }}>
              {i + 1}
            </span>
            <span className="grow" dir="auto">
              {it.clues[i] ?? (
                <span className="muted">{t('gm_clueLocked', { n: i + 1, s: it.clueTimes[i] / 1000 })}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {v.phase === 'QUESTION' && role === 'PLAYER' && !mine && (
        <p className="small muted" style={{ margin: 0 }}>
          {t('gm_worth', { pts: worth })}
        </p>
      )}
      <Options
        options={it.options}
        picked={mine?.optionId}
        correctId={it.correctOptionId}
        disabled={!canAnswer}
        onPick={(id) => client.act({ type: 'answer', optionId: id, itemIndex: v.itemIndex })}
      />
      <Locked show={!!mine && v.phase === 'QUESTION'}>{t('gm_confirmed', { n: mine?.tier ?? 1 })}</Locked>
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Who Am I?
export function WhoAmI({ v, me, role, players }: ModeProps) {
  const { t, locale } = useI18n();
  const it = v.item;
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine;
  const worth = [5, 4, 3, 2, 1][Math.max(0, it.clues.length - 1)] ?? 1;
  return (
    <div className="stage">
      <Head
        label={modeName('who_am_i', locale)}
        index={v.itemIndex}
        count={v.itemCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      <h2 className="prompt">{t('wai_prompt')}</h2>
      <ol className="list" aria-label={t('clues')}>
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="list-item">
            <span className="num accent" style={{ fontSize: 22 }}>
              {i + 1}
            </span>
            <span className="grow" dir="auto">
              {it.clues[i] ?? (
                <span className="muted">{t('gm_clueLocked', { n: i + 1, s: it.clueTimes[i] / 1000 })}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
      {canAnswer && (
        <>
          <p className="small muted" style={{ margin: 0 }}>
            {t('gm_worth', { pts: worth })}
          </p>
          <TextAnswer
            disabled={!canAnswer}
            onSubmit={(text) => client.act({ type: 'answer', text, itemIndex: v.itemIndex })}
            placeholder={t('typeAnswer')}
          />
        </>
      )}
      <Locked show={!!mine && v.phase === 'QUESTION'}>
        {t('lockedIn', { answer: mine?.text ?? '' })} · {t('gm_confirmed', { n: mine?.tier ?? 1 })}
      </Locked>
      {it.answer && <Banner tone="info">{t('wai_answer', { answer: it.answer })}</Banner>}
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Connections
export function Connections({ v, me, role, players }: ModeProps) {
  const { t, locale } = useI18n();
  const it = v.item;
  const names = useNames();
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine;
  return (
    <div className="stage">
      <Head
        label={modeName('connections', locale)}
        index={v.itemIndex}
        count={v.itemCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      <h2 className="prompt">{t('conn_prompt')}</h2>
      <div className="options">
        {it.entities.map((e: string) => (
          <div key={e} className="option" style={{ cursor: 'default' }} dir="auto">
            {e}
          </div>
        ))}
      </div>
      {canAnswer && (
        <TextAnswer
          disabled={!canAnswer}
          onSubmit={(text) => client.act({ type: 'answer', text, itemIndex: v.itemIndex })}
          placeholder={t('conn_placeholder')}
        />
      )}
      <p className="small muted" style={{ margin: 0 }}>
        {t('conn_rule')}
      </p>
      <Locked show={!!mine && v.phase === 'QUESTION'}>{t('lockedIn', { answer: mine ?? '' })}</Locked>
      {v.phase === 'REVIEW' && <Banner tone="warn">{t('conn_reviewing')}</Banner>}
      {role === 'JUDGE' && v.reviews?.length > 0 && (
        <div className="card stack">
          <div className="eyebrow">{t('conn_review', { link: v.reviewKey?.link ?? '' })}</div>
          {v.reviews.map((r: any) => (
            <div key={r.memberId} className="list-item">
              <span className="grow">
                <strong>{names[r.memberId]}</strong>: «<span dir="auto">{r.answer}</span>»
              </span>
              <button
                className="btn sm"
                onClick={() => client.act({ type: 'review', memberId: r.memberId, accept: true })}
              >
                {t('conn_valid')}
              </button>
              <button
                className="btn sm danger"
                onClick={() => client.act({ type: 'review', memberId: r.memberId, accept: false })}
              >
                {t('conn_invalid')}
              </button>
            </div>
          ))}
        </div>
      )}
      {it.link && (
        <Banner tone="info">{t('conn_link', { link: it.link, explanation: it.explanation ?? '' })}</Banner>
      )}
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Risk It
const RISK_PAYOFF = { SAFE: '+1 / 0', BOLD: '+3 / −1', ALL_IN: '+6 / −3' } as const;
type RiskKey = keyof typeof RISK_PAYOFF;

export function RiskIt({ v, players }: ModeProps) {
  const { t } = useI18n();
  const names = useNames();
  const it = v.item;
  const riskName = (r: RiskKey) => t(`risk_${r}` as const);
  return (
    <div className="stage">
      <Head
        label={t('risk_label', { name: names[v.player] ?? '' })}
        index={v.turnIndex}
        count={v.turnCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      <div className="row">
        <Avatar id={v.player} name={names[v.player] ?? '?'} />
        <strong>{v.isMyTurn ? t('risk_yourTurn') : names[v.player]}</strong>
        {v.risk && (
          <span className="badge info">
            {riskName(v.risk)} <span dir="ltr">{RISK_PAYOFF[v.risk as RiskKey]}</span>
            {v.riskDefaulted ? ` ${t('risk_auto')}` : ''}
          </span>
        )}
      </div>
      {v.phase === 'CHOOSE' &&
        (v.isMyTurn ? (
          <div className="options" role="group" aria-label={t('risk_chooseAria')}>
            {(Object.keys(RISK_PAYOFF) as RiskKey[]).map((r) => (
              <button key={r} className="option" onClick={() => client.act({ type: 'risk', risk: r })}>
                <span className="key">{r === 'SAFE' ? '1' : r === 'BOLD' ? '3' : '6'}</span>
                <span>
                  <strong>{riskName(r)}</strong>
                  <br />
                  <span className="small muted">{t('risk_payoff', { payoff: RISK_PAYOFF[r] })}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Banner>{t('risk_choosing', { name: names[v.player] ?? '' })}</Banner>
        ))}
      {it && (
        <>
          <h2 className="prompt" dir="auto">
            {it.prompt}
          </h2>
          <Options
            options={it.options}
            picked={v.answer}
            correctId={it.correctOptionId}
            disabled={!v.isMyTurn || v.phase !== 'ANSWER'}
            onPick={(id) => client.act({ type: 'answer', optionId: id })}
          />
        </>
      )}
      {v.phase === 'REVEAL' && (
        <Banner tone={v.correct ? 'ok' : v.correct === null ? 'warn' : 'bad'}>
          {v.correct === null ? t('voided') : v.correct ? t('correct') : v.answer ? t('wrong') : t('timeUp')}
          {v.correct !== null && (
            <span dir="ltr">
              {' '}
              · {v.delta > 0 ? '+' : ''}
              {v.delta}
            </span>
          )}
        </Banner>
      )}
      <Attribution text={it?.attribution} />
      <ScoreStrip scores={v.scores} players={players} highlight={v.player} />
    </div>
  );
}

// ---------------------------------------------------------------- Timeline
export function Timeline({ v, me, players }: ModeProps) {
  const { t } = useI18n();
  const names = useNames();
  const it = v.item;
  const myPick = me ? v.picks[me] : null;
  return (
    <div className="stage">
      <Head
        label={t('tl_label')}
        index={v.duelIndex}
        count={v.duelCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      <div className="row" style={{ justifyContent: 'center', gap: 16 }}>
        <span className="row">
          <Avatar id={v.initiator} name={names[v.initiator] ?? '?'} /> <strong>{names[v.initiator]}</strong>
        </span>
        <span className="display h3 muted">VS</span>
        <span className="row">
          <Avatar id={v.opponent} name={names[v.opponent] ?? '?'} /> <strong>{names[v.opponent]}</strong>
        </span>
      </div>
      {v.phase === 'INTRO' && (
        <Banner>{t('tl_challenge', { a: names[v.initiator] ?? '', b: names[v.opponent] ?? '' })}</Banner>
      )}
      {it && (
        <>
          <h2 className="prompt" dir="auto">
            {it.prompt}
          </h2>
          <div className="options">
            {it.events.map((e: any) => {
              const earlier = it.earlierId === e.id;
              return (
                <button
                  key={e.id}
                  className={`option ${it.earlierId ? (earlier ? 'correct' : '') : myPick === e.id ? 'picked' : ''}`}
                  disabled={!v.inDuel || v.phase !== 'ANSWER' || !!myPick}
                  onClick={() => client.act({ type: 'pick', eventId: e.id })}
                >
                  <span dir="auto">
                    {e.label}
                    {e.date && <span className="small muted"> · {e.date}</span>}
                  </span>
                  {earlier && <span className="verdict accent">{t('tl_first')}</span>}
                </button>
              );
            })}
          </div>
          {!v.inDuel && v.phase === 'ANSWER' && <Banner>{t('tl_watching')}</Banner>}
          {v.phase !== 'ANSWER' && v.picks && (
            <div className="row small">
              {[v.initiator, v.opponent].map((m: string) => (
                <span key={m} className={`badge ${v.correct ? (v.correct[m] ? 'ok' : 'bad') : ''}`}>
                  {names[m]}:{' '}
                  {v.correct ? (v.correct[m] ? t('correct') : t('wrong')) : v.picks[m] ? t('tl_locked') : '—'}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {v.voided && <Banner tone="warn">{t('tl_voided')}</Banner>}
      <Attribution text={it?.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- TOP 25
export function Top25({ v, players }: ModeProps) {
  const { t } = useI18n();
  const names = useNames();
  const last = v.lastGuess;
  const lastText = !last
    ? ''
    : last.text === null
      ? t('t25_timeUp')
      : last.duplicate
        ? t('t25_dup')
        : last.rank
          ? t('t25_hit', { rank: last.rank })
          : t('t25_miss');
  return (
    <div className="stage">
      <Head
        label={t('t25_label', { n: v.round + 1 })}
        end={v.phase === 'TURN' ? v.phaseEnd : null}
        start={v.phaseStart}
      />
      <div>
        <h2 className="prompt" dir="auto">
          {v.title}
        </h2>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          {t('t25_rule', { scope: v.scope, target: v.target })}
        </p>
      </div>
      <div className="row small">
        <span className="eyebrow">{t('t25_order')}</span>
        {v.order.map((m: string) => (
          <span key={m} className={`badge ${m === v.player ? 'info' : ''}`}>
            {names[m]}
          </span>
        ))}
      </div>
      {v.phase === 'TURN' &&
        (v.isMyTurn ? (
          <TextAnswer
            disabled={false}
            onSubmit={(text) => client.act({ type: 'guess', text })}
            placeholder={t('t25_placeholder')}
            cta={t('t25_guess')}
          />
        ) : (
          <Banner>{t('t25_guessing', { name: names[v.player] ?? '' })}</Banner>
        ))}
      {last && (
        <Banner tone={last.rank && !last.duplicate ? 'ok' : 'bad'}>
          {names[last.player]}: «<span dir="auto">{last.text ?? '—'}</span>» ← {lastText}
        </Banner>
      )}
      {v.endReason && (
        <Banner tone="info">
          {v.endReason === 'TARGET'
            ? t('t25_endTarget', { target: v.target })
            : v.endReason === 'EXHAUSTED'
              ? t('t25_endExhausted')
              : t('t25_endCap')}
        </Banner>
      )}
      <div className="grid25" aria-label={t('t25_list')}>
        {v.grid.map((c: any) => (
          <div key={c.rank} className={`cell25 ${c.foundBy ? 'found' : ''}`}>
            <span className="num">{c.rank}</span>
            <span className="truncate" style={{ flex: 1 }} dir="auto">
              {c.label ?? <span className="muted">{t('t25_hidden')}</span>}
            </span>
            {c.foundBy && <Avatar id={c.foundBy} name={names[c.foundBy] ?? '?'} size={22} />}
          </div>
        ))}
      </div>
      <Attribution text={v.attribution} />
      <ScoreStrip scores={v.scores} players={players} highlight={v.player} />
    </div>
  );
}

// ---------------------------------------------------------------- Buzzer Battle
export function Buzzer({ v, me, role, players }: ModeProps) {
  const { t } = useI18n();
  const names = useNames();
  const isJudge = role === 'JUDGE';
  const now = useGameNow();
  return (
    <div className="stage">
      <Head
        label={t('bz_label')}
        index={v.itemIndex}
        count={v.itemCount}
        end={v.phase === 'ANSWERING' ? v.answerWindowEnd : v.phaseEnd}
        start={v.phaseStart}
      />
      <h2 className="prompt" dir="auto">
        {v.prompt}
      </h2>
      {isJudge && (
        <Banner tone="warn" icon="⚖">
          {t('bz_key')} <strong dir="auto">{v.answer}</strong>
          {v.aliases?.length ? (
            <span className="muted"> · {t('bz_also', { list: v.aliases.join('، ') })}</span>
          ) : null}
        </Banner>
      )}
      {v.phase === 'ANSWERING' && (
        <Banner tone="info">{t('bz_floor', { name: names[v.onFloor] ?? '' })}</Banner>
      )}
      {isJudge && v.phase === 'ANSWERING' && (
        <div className="row">
          <button className="btn primary" onClick={() => client.act({ type: 'verdict', verdict: 'CORRECT' })}>
            {t('bz_correct')}
          </button>
          <button className="btn danger" onClick={() => client.act({ type: 'verdict', verdict: 'WRONG' })}>
            {t('bz_wrong')}
          </button>
          <button
            className="btn"
            disabled={now < v.answerWindowEnd}
            onClick={() => client.act({ type: 'verdict', verdict: 'TIMEOUT' })}
          >
            {t('bz_noAnswer')}
          </button>
        </div>
      )}
      {role === 'PLAYER' && v.phase !== 'REVEAL' && v.phase !== 'DONE' && (
        <button
          className="buzzer"
          disabled={!v.canBuzz}
          onClick={() => client.act({ type: 'buzz' })}
          aria-label={t('bz_buzz')}
        >
          {v.canBuzz ? t('bz_buzz') : v.lockedOut.includes(me) ? t('bz_used') : t('bz_wait')}
        </button>
      )}
      {v.phase === 'REVEAL' && (
        <Banner tone="info">
          {t('bz_answer', { answer: v.answer ?? '', explanation: v.explanation ?? '' })}
        </Banner>
      )}
      <div className="row small">
        {v.buzzes.map((b: any, i: number) => (
          <span key={i} className={`badge ${b.verdict === 'CORRECT' ? 'ok' : b.verdict ? 'bad' : 'info'}`}>
            {i + 1}. {names[b.player]}{' '}
            {b.verdict
              ? `· ${b.verdict === 'CORRECT' ? t('correct') : b.verdict === 'WRONG' ? t('wrong') : b.verdict === 'TIMEOUT' ? t('timeUp') : t('voided')}`
              : ''}
          </span>
        ))}
      </div>
      <Attribution text={v.attribution} />
      <ScoreStrip scores={v.scores} players={players} highlight={v.onFloor} />
    </div>
  );
}

// ---------------------------------------------------------------- The Impostor
export function Impostor({ v, me, role, players }: ModeProps) {
  const { t } = useI18n();
  const names = useNames();
  const phaseLabel =
    v.phase === 'CLUES' ? t('imp_CLUES', { n: v.clueCycle ?? '' }) : t(`imp_${v.phase}` as 'imp_REVEAL');
  const live = v.phase !== 'ROUND_REVEAL' && v.phase !== 'DONE';
  return (
    <div className="stage">
      <Head
        label={t('imp_label', { phase: phaseLabel })}
        index={v.round}
        count={v.roundCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      {v.role === 'IMPOSTOR' && live && (
        <div className="card" style={{ borderColor: 'var(--danger)', textAlign: 'center' }}>
          <div className="display h2" style={{ color: 'var(--danger)' }}>
            {t('imp_youAre')}
          </div>
          <p className="muted">{t('imp_blend')}</p>
        </div>
      )}
      {v.role === 'CREW' && live && (
        <div className="card pitch" style={{ textAlign: 'center' }}>
          <div className="eyebrow">{t('imp_secret')}</div>
          <div className="display h2 accent" dir="auto">
            {v.footballer}
          </div>
          <p className="muted small" dir="auto">
            {v.context}
          </p>
        </div>
      )}
      {role !== 'PLAYER' && v.phase !== 'ROUND_REVEAL' && (
        <Banner>{role === 'JUDGE' ? t('imp_hiddenJudge') : t('imp_hiddenSpec')}</Banner>
      )}
      {v.phase === 'CLUES' && (
        <div className="row">
          <Avatar id={v.clueGiver} name={names[v.clueGiver] ?? '?'} />
          <strong>
            {v.clueGiver === me ? t('imp_yourClue') : t('imp_givingClue', { name: names[v.clueGiver] ?? '' })}
          </strong>
          {v.clueGiver === me && (
            <button className="btn sm" onClick={() => client.act({ type: 'clueDone' })}>
              {t('imp_done')}
            </button>
          )}
        </div>
      )}
      {v.phase === 'DISCUSSION' && <Banner>{t('imp_discuss')}</Banner>}
      {v.phase === 'VOTE' && role === 'PLAYER' && (
        <div className="stack">
          <div className="eyebrow">
            {v.myVote ? t('imp_votedFor', { name: names[v.myVote] ?? '' }) : t('imp_voteNow')}
          </div>
          <div className="options">
            {players
              .filter((p) => p !== me)
              .map((p) => (
                <button
                  key={p}
                  className={`option ${v.myVote === p ? 'picked' : ''}`}
                  disabled={!!v.myVote}
                  onClick={() => client.act({ type: 'vote', target: p })}
                >
                  <Avatar id={p} name={names[p] ?? '?'} /> {names[p]}
                </button>
              ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            {t('imp_voteCount', { n: v.voted.length, total: players.length })}
          </p>
        </div>
      )}
      {v.phase === 'GUESS' && (
        <>
          <Banner tone="warn">{t('imp_caught', { name: names[v.impostor] ?? '' })}</Banner>
          {v.role === 'IMPOSTOR' && (
            <TextAnswer
              disabled={false}
              onSubmit={(text) => client.act({ type: 'guess', text })}
              placeholder={t('imp_guessPh')}
              cta={t('imp_guess')}
            />
          )}
        </>
      )}
      {v.phase === 'ROUND_REVEAL' && (
        <div className="card stack">
          <div>
            {t('imp_reveal', {
              footballer: v.footballer ?? '',
              name: names[v.impostor] ?? '',
              outcome: v.caught ? t('imp_wasCaught') : t('imp_escaped'),
            })}
          </div>
          {v.caught && (
            <div>
              {t('imp_guessWas', {
                guess: v.guess ?? '—',
                result: v.guessCorrect ? t('imp_right') : t('imp_wrong'),
              })}
            </div>
          )}
          <div className="row small">
            {Object.entries(v.votes ?? {}).map(([voter, target]) => (
              <span key={voter} className={`badge ${target === v.impostor ? 'ok' : ''}`}>
                {names[voter]} ← {names[target as string]}
              </span>
            ))}
          </div>
          <div className="row small">
            {Object.entries(v.roundPoints ?? {}).map(([m, pts]) => (
              <span key={m} className="badge info">
                {names[m]} <span dir="ltr">+{String(pts)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <Attribution text={v.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Auction + 30 seconds
export function Auction({ v, me, role, players }: ModeProps) {
  const { t } = useI18n();
  const names = useNames();
  const [amount, setAmount] = useState<number>(Math.max(1, (v.bid ?? 0) + 1));
  const myTurn = role === 'PLAYER' && v.turn === me;
  const min = (v.bid ?? 0) + 1;
  const isJudge = role === 'JUDGE';
  const [name, setName] = useState('');
  return (
    <div className="stage">
      <Head
        label={t('au_label', { phase: t(`au_${v.phase}` as 'au_BIDDING') })}
        index={v.round}
        count={v.roundCount}
        end={v.phaseEnd}
        start={v.phaseStart}
      />
      <div>
        <h2 className="prompt" dir="auto">
          {v.category}
        </h2>
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          {t('au_maxBid', { scope: v.scope, n: v.maxBid })}
        </p>
      </div>
      <div className="row">
        <span className="badge info">
          {t('au_current', { bid: v.bid || '—' })}{' '}
          {v.bidder ? t('au_by', { name: names[v.bidder] ?? '' }) : ''}
        </span>
        {v.challenger && (
          <span className="badge warn">{t('au_challenger', { name: names[v.challenger] ?? '' })}</span>
        )}
      </div>
      {v.phase === 'BIDDING' &&
        (myTurn ? (
          <div className="card stack">
            <div className="eyebrow">{t('au_yourBid')}</div>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button
                className="btn"
                aria-label={t('au_decrease')}
                onClick={() => setAmount(Math.max(min, amount - 1))}
              >
                −
              </button>
              <span
                className="num"
                style={{ fontSize: 40, minWidth: 60, textAlign: 'center' }}
                aria-live="polite"
              >
                {Math.max(amount, min)}
              </span>
              <button
                className="btn"
                aria-label={t('au_increase')}
                onClick={() => setAmount(Math.min(v.maxBid, Math.max(amount, min) + 1))}
              >
                +
              </button>
              <button
                className="btn primary"
                onClick={() => client.act({ type: 'bid', amount: Math.max(amount, min) })}
              >
                {t('au_bid')}
              </button>
              {v.bidder && (
                <button className="btn danger" onClick={() => client.act({ type: 'drop' })}>
                  {t('au_drop')}
                </button>
              )}
            </div>
          </div>
        ) : (
          <Banner>{t('au_deciding', { name: names[v.turn] ?? '' })}</Banner>
        ))}
      {(v.phase === 'AWAIT_JUDGE' || v.phase === 'CHALLENGE') && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="eyebrow">{t('au_mustName', { name: names[v.bidder] ?? '', n: v.bid })}</div>
          <div className="num" style={{ fontSize: 72 }} aria-live="polite" dir="ltr">
            {v.count} / {v.bid}
          </div>
          {v.phase === 'AWAIT_JUDGE' && <p className="muted">{t('au_judgeStarts')}</p>}
        </div>
      )}
      {isJudge && (v.phase === 'AWAIT_JUDGE' || v.phase === 'CHALLENGE') && (
        <div className="card stack">
          <div className="eyebrow">{t('au_counter')}</div>
          <form
            className="answer-form"
            onSubmit={(e) => {
              e.preventDefault();
              void client.act({ type: 'tap', ...(name.trim() ? { name: name.trim() } : {}) });
              setName('');
            }}
          >
            <input
              className="input"
              dir="auto"
              placeholder={t('au_heard')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn primary">{t('au_valid')}</button>
          </form>
          <button className="btn" disabled={v.count === 0} onClick={() => client.act({ type: 'undo' })}>
            {t('au_undo')}
          </button>
          <details>
            <summary className="small muted">{t('au_universe', { n: v.universe?.length ?? 0 })}</summary>
            <p className="small" style={{ columns: 2 }} dir="auto">
              {v.universe?.join(' · ')}
            </p>
          </details>
        </div>
      )}
      {v.phase === 'ROUND_REVEAL' && (
        <Banner tone={v.outcome === 'SUCCESS' ? 'ok' : 'bad'}>
          {v.outcome === 'SUCCESS'
            ? t('au_success', { name: names[v.bidder] ?? '' })
            : t('au_fail', { name: names[v.bidder] ?? '', challenger: names[v.challenger] ?? '—' })}
        </Banner>
      )}
      <Attribution text={v.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

export function ModeView(props: ModeProps & { runKey: string }) {
  const { t } = useI18n();
  switch (props.runKey) {
    case 'higher_lower':
      return <HigherLower {...props} />;
    case 'last_man_standing':
      return <LastManStanding {...props} />;
    case 'missing_xi':
      return <MissingXi {...props} />;
    case 'guess_the_match':
      return <GuessTheMatch {...props} />;
    case 'connections':
      return <Connections {...props} />;
    case 'who_am_i':
      return <WhoAmI {...props} />;
    case 'risk_it':
      return <RiskIt {...props} />;
    case 'timeline':
      return <Timeline {...props} />;
    case 'top25':
      return <Top25 {...props} />;
    case 'buzzer':
      return <Buzzer {...props} />;
    case 'impostor':
      return <Impostor {...props} />;
    case 'auction':
      return <Auction {...props} />;
    case 'tiebreak':
      return <Mcq {...props} label={t('tiebreakTitle')} />;
    default:
      return <Banner tone="bad">{t('err_generic')}</Banner>;
  }
}
