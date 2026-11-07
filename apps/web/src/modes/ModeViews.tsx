/* eslint-disable @typescript-eslint/no-explicit-any -- engine views are server projections typed per mode below */
import { useState, type FormEvent, type ReactNode } from 'react';
import { client } from '../net/client.js';
import { useGame, useGameNow } from '../net/hooks.js';
import { useI18n } from '../i18n.js';
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

function Head({ label, index, count, end, start }: { label: string; index?: number; count?: number; end: number | null; start?: number | null }) {
  const { t } = useI18n();
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <span className="eyebrow">{label}</span>
        <span className="spacer" />
        {index !== undefined && count !== undefined && (
          <span className="eyebrow" aria-label={`${t('question')} ${index + 1} ${t('of')} ${count}`}>
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
  return <Banner tone="info" icon="🔒">{children ?? t('submitted')}</Banner>;
}

function TextAnswer({ disabled, onSubmit, placeholder, cta }: { disabled: boolean; onSubmit: (s: string) => Promise<unknown>; placeholder?: string; cta?: string }) {
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
    <form className="row" onSubmit={submit} style={{ flexWrap: 'nowrap' }}>
      <label className="sr-only" htmlFor="answer">
        {placeholder ?? t('typeAnswer')}
      </label>
      <input id="answer" className="input" autoComplete="off" maxLength={80} value={text} disabled={disabled || busy} placeholder={placeholder ?? t('typeAnswer')} onChange={(e) => setText(e.target.value)} />
      <button className="btn primary" disabled={disabled || busy || !text.trim()}>
        {cta ?? t('submit')}
      </button>
    </form>
  );
}

/** Four-option grid; reveal states use colour AND text labels (never colour alone). */
function Options({ options, picked, correctId, disabled, onPick }: { options: { id: string; label: string }[]; picked?: string | null; correctId?: string | null; disabled: boolean; onPick: (id: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="options" role="group">
      {options.map((o, i) => {
        const isCorrect = correctId && o.id === correctId;
        const isWrongPick = correctId && picked === o.id && o.id !== correctId;
        const cls = isCorrect ? 'correct' : isWrongPick ? 'incorrect' : picked === o.id ? 'picked' : '';
        return (
          <button key={o.id} className={`option ${cls}`} disabled={disabled} aria-pressed={picked === o.id} onClick={() => onPick(o.id)}>
            <span className="key" aria-hidden="true">
              {KEYS[i]}
            </span>
            <span>{o.label}</span>
            {isCorrect && <span className="verdict accent">✓ {t('correct')}</span>}
            {isWrongPick && <span className="verdict" style={{ color: 'var(--danger)' }}>✕ {t('wrong')}</span>}
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
  if (!mine.answered) return <Banner tone="bad">{t('timeUp')}</Banner>;
  return mine.correct ? <Banner tone="ok" icon="✓">{t('correct')}</Banner> : <Banner tone="bad" icon="✕">{t('wrong')}</Banner>;
}

function AnsweredRow({ v, players }: { v: any; players: string[] }) {
  const names = useNames();
  const subs = v.submissions ?? {};
  return (
    <div className="row small muted" aria-label="Answer status">
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
  const it = v.item;
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine && v.eligible.includes(me);
  const send = (choice: string) => client.act({ type: 'answer', choice, itemIndex: v.itemIndex });
  return (
    <div className="stage">
      <Head label={it.statLabel} index={v.itemIndex} count={v.itemCount} end={v.phase === 'QUESTION' || v.phase === 'REVEAL' ? v.phaseEnd : null} start={v.phaseStart} />
      <p className="muted small" style={{ margin: 0 }}>{it.scope}</p>
      <div className="versus">
        <div className="statcard">
          <span className="eyebrow">A</span>
          <strong>{it.a.label}</strong>
          <span className="big">{it.a.value}</span>
          <span className="muted small">{it.unit}</span>
        </div>
        <div className="vs">VS</div>
        <div className="statcard" style={it.correct ? { borderColor: 'var(--accent)' } : undefined}>
          <span className="eyebrow">B</span>
          <strong>{it.b.label}</strong>
          <span className="big">{it.b.value ?? '?'}</span>
          <span className="muted small">{it.unit}</span>
        </div>
      </div>
      {v.phase === 'QUESTION' && role === 'PLAYER' && (
        <div className="options">
          <button className={`option ${mine === 'HIGHER' ? 'picked' : ''}`} disabled={!canAnswer} onClick={() => send('HIGHER')}>
            <span className="key">▲</span> B is higher
          </button>
          <button className={`option ${mine === 'LOWER' ? 'picked' : ''}`} disabled={!canAnswer} onClick={() => send('LOWER')}>
            <span className="key">▼</span> B is lower
          </button>
        </div>
      )}
      <Locked show={!!mine && v.phase === 'QUESTION'}>Locked in: B is {mine === 'HIGHER' ? 'higher' : 'lower'}</Locked>
      {it.correct && <Banner tone="info">B is {it.correct === 'HIGHER' ? 'higher' : 'lower'}.</Banner>}
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- MCQ-based: Last Man Standing & tiebreak
export function Mcq({ v, me, role, players, label, extra }: ModeProps & { label: string; extra?: ReactNode }) {
  const it = v.item;
  const mine = me ? v.submissions?.[me]?.answer : null;
  const eligible = me ? v.eligible.includes(me) : false;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine && eligible;
  return (
    <div className="stage">
      <Head label={label} index={v.itemIndex} count={v.itemCount} end={v.phaseEnd} start={v.phaseStart} />
      {extra}
      <h2 className="prompt">{it.prompt}</h2>
      <Options options={it.options} picked={mine} correctId={it.correctOptionId} disabled={!canAnswer} onPick={(id) => client.act({ type: 'answer', optionId: id, itemIndex: v.itemIndex })} />
      {role === 'PLAYER' && !eligible && v.phase === 'QUESTION' && <Banner tone="warn">You are watching this question.</Banner>}
      <RevealNote v={v} me={me} />
      {it.explanation && <p className="muted" style={{ margin: 0 }}>{it.explanation}</p>}
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
    </div>
  );
}

export function LastManStanding(p: ModeProps) {
  const names = useNames();
  const hearts: Record<string, number> = p.v.extra?.hearts ?? {};
  return (
    <>
      <Mcq
        {...p}
        label="Survival Arena"
        extra={
          <div className="row" aria-label="Hearts">
            {p.players.map((m) => (
              <span key={m} className={`badge ${hearts[m] ? '' : 'bad'}`}>
                {names[m]} {hearts[m] ? '❤'.repeat(hearts[m]) : 'OUT'}
                <span className="sr-only">{hearts[m]} hearts</span>
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
      <Head label="Missing XI" index={v.itemIndex} count={v.itemCount} end={v.phaseEnd} start={v.phaseStart} />
      <div>
        <h2 className="prompt">{it.match}</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          {it.date} · {it.team} kickoff XI · {it.formation}
        </p>
      </div>
      <div className="formation" aria-label="Kickoff lineup">
        {rows.map((row: any[], i: number) => (
          <div key={i} className="formation-row">
            {row.map((s: any) => (
              <div key={s.slot} className={`shirt ${s.player ? '' : 'missing'}`}>
                <div className="eyebrow" style={{ fontSize: 11 }}>{s.position}</div>
                <div>{s.player ?? (it.answer ? it.answer : '?')}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {it.hints.map((h: string, i: number) => (
        <Banner key={i} tone="info" icon="💡">
          {h}
        </Banner>
      ))}
      {role === 'PLAYER' && v.phase === 'QUESTION' && !mine && it.hintsViewed < 2 && (
        <button className="btn" disabled={!hintReady} onClick={() => client.act({ type: 'hint', itemIndex: v.itemIndex })}>
          {hintReady ? `Reveal hint ${it.hintsViewed + 1} (max drops to ${[3, 1][it.hintsViewed]})` : `Hint ${it.hintsViewed + 1} unlocks in ${Math.ceil((nextHintAt! - now) / 1000)}s`}
        </button>
      )}
      {role === 'PLAYER' && v.phase === 'QUESTION' && <p className="small muted" style={{ margin: 0 }}>One answer only — it cannot be changed. Worth +{value} now.</p>}
      {canAnswer && <TextAnswer disabled={!canAnswer} onSubmit={(text) => client.act({ type: 'answer', text, itemIndex: v.itemIndex })} placeholder="Missing player's name" />}
      <Locked show={!!mine && v.phase === 'QUESTION'}>Locked in: {mine?.text}</Locked>
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Guess the Match
export function GuessTheMatch({ v, me, role, players }: ModeProps) {
  const it = v.item;
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine;
  const worth = [5, 3, 1][Math.max(0, it.clues.length - 1)] ?? 1;
  return (
    <div className="stage">
      <Head label="Guess the Match" index={v.itemIndex} count={v.itemCount} end={v.phaseEnd} start={v.phaseStart} />
      <ol className="list" aria-label="Clues">
        {[0, 1, 2].map((i) => (
          <li key={i} className="list-item">
            <span className="num accent" style={{ fontSize: 22 }}>{i + 1}</span>
            <span className="grow">{it.clues[i] ?? <span className="muted">Clue {i + 1} unlocks at {it.clueTimes[i] / 1000}s</span>}</span>
          </li>
        ))}
      </ol>
      {v.phase === 'QUESTION' && role === 'PLAYER' && !mine && <p className="small muted" style={{ margin: 0 }}>One confirmed answer. Worth +{worth} right now (no speed bonus).</p>}
      <Options options={it.options} picked={mine?.optionId} correctId={it.correctOptionId} disabled={!canAnswer} onPick={(id) => client.act({ type: 'answer', optionId: id, itemIndex: v.itemIndex })} />
      <Locked show={!!mine && v.phase === 'QUESTION'}>Confirmed with {mine?.tier} clue(s)</Locked>
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Connections
export function Connections({ v, me, role, players }: ModeProps) {
  const it = v.item;
  const names = useNames();
  const mine = me ? v.submissions?.[me]?.answer : null;
  const canAnswer = role === 'PLAYER' && v.phase === 'QUESTION' && !mine;
  return (
    <div className="stage">
      <Head label="Connections" index={v.itemIndex} count={v.itemCount} end={v.phaseEnd} start={v.phaseStart} />
      <h2 className="prompt">What links these four?</h2>
      <div className="options">
        {it.entities.map((e: string) => (
          <div key={e} className="option" style={{ cursor: 'default' }}>
            {e}
          </div>
        ))}
      </div>
      {canAnswer && <TextAnswer disabled={!canAnswer} onSubmit={(text) => client.act({ type: 'answer', text, itemIndex: v.itemIndex })} placeholder="The connection" />}
      <p className="small muted" style={{ margin: 0 }}>Earliest correct +3, other correct +2. One answer each.</p>
      <Locked show={!!mine && v.phase === 'QUESTION'}>Locked in: {mine}</Locked>
      {v.phase === 'REVIEW' && <Banner tone="warn">The judge is reviewing alternative links…</Banner>}
      {role === 'JUDGE' && v.reviews?.length > 0 && (
        <div className="card stack">
          <div className="eyebrow">Review alternative links · official: {v.reviewKey?.link}</div>
          {v.reviews.map((r: any) => (
            <div key={r.memberId} className="list-item">
              <span className="grow">
                <strong>{names[r.memberId]}</strong>: “{r.answer}”
              </span>
              <button className="btn sm" onClick={() => client.act({ type: 'review', memberId: r.memberId, accept: true })}>
                Valid
              </button>
              <button className="btn sm danger" onClick={() => client.act({ type: 'review', memberId: r.memberId, accept: false })}>
                Not valid
              </button>
            </div>
          ))}
        </div>
      )}
      {it.link && <Banner tone="info">Link: {it.link}. {it.explanation}</Banner>}
      <RevealNote v={v} me={me} />
      <AnsweredRow v={v} players={players} />
      <Attribution text={it.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- Risk It
export function RiskIt({ v, players }: ModeProps) {
  const names = useNames();
  const it = v.item;
  const RISK = { SAFE: '+1 / 0', BOLD: '+3 / −1', ALL_IN: '+6 / −3' } as const;
  return (
    <div className="stage">
      <Head label={`Risk It · ${names[v.player]}'s turn`} index={v.turnIndex} count={v.turnCount} end={v.phaseEnd} start={v.phaseStart} />
      <div className="row">
        <Avatar id={v.player} name={names[v.player] ?? '?'} />
        <strong>{v.isMyTurn ? 'Your turn' : names[v.player]}</strong>
        {v.risk && <span className="badge info">{v.risk.replace('_', ' ')} {RISK[v.risk as keyof typeof RISK]}{v.riskDefaulted ? ' (auto)' : ''}</span>}
      </div>
      {v.phase === 'CHOOSE' && (
        v.isMyTurn ? (
          <div className="options" role="group" aria-label="Choose risk">
            {(Object.keys(RISK) as Array<keyof typeof RISK>).map((r) => (
              <button key={r} className="option" onClick={() => client.act({ type: 'risk', risk: r })}>
                <span className="key">{r === 'SAFE' ? '1' : r === 'BOLD' ? '3' : '6'}</span>
                <span>
                  <strong>{r.replace('_', ' ')}</strong>
                  <br />
                  <span className="small muted">correct / wrong: {RISK[r]}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <Banner>{names[v.player]} is choosing a risk level…</Banner>
        )
      )}
      {it && (
        <>
          <h2 className="prompt">{it.prompt}</h2>
          <Options options={it.options} picked={v.answer} correctId={it.correctOptionId} disabled={!v.isMyTurn || v.phase !== 'ANSWER'} onPick={(id) => client.act({ type: 'answer', optionId: id })} />
        </>
      )}
      {v.phase === 'REVEAL' && <Banner tone={v.correct ? 'ok' : v.correct === null ? 'warn' : 'bad'}>{v.correct === null ? 'Voided' : `${v.correct ? 'Correct' : v.answer ? 'Wrong' : "Time's up"} · ${v.delta > 0 ? '+' : ''}${v.delta}`}</Banner>}
      <Attribution text={it?.attribution} />
      <ScoreStrip scores={v.scores} players={players} highlight={v.player} />
    </div>
  );
}

// ---------------------------------------------------------------- Timeline
export function Timeline({ v, me, players }: ModeProps) {
  const names = useNames();
  const it = v.item;
  const myPick = me ? v.picks[me] : null;
  return (
    <div className="stage">
      <Head label="History Duel" index={v.duelIndex} count={v.duelCount} end={v.phaseEnd} start={v.phaseStart} />
      <div className="row" style={{ justifyContent: 'center', gap: 16 }}>
        <span className="row"><Avatar id={v.initiator} name={names[v.initiator] ?? '?'} /> <strong>{names[v.initiator]}</strong></span>
        <span className="display h3 muted">vs</span>
        <span className="row"><Avatar id={v.opponent} name={names[v.opponent] ?? '?'} /> <strong>{names[v.opponent]}</strong></span>
      </div>
      {v.phase === 'INTRO' && <Banner>{names[v.initiator]} challenges {names[v.opponent]}. Get ready…</Banner>}
      {it && (
        <>
          <h2 className="prompt">{it.prompt}</h2>
          <div className="options">
            {it.events.map((e: any) => {
              const earlier = it.earlierId === e.id;
              return (
                <button key={e.id} className={`option ${it.earlierId ? (earlier ? 'correct' : '') : myPick === e.id ? 'picked' : ''}`} disabled={!v.inDuel || v.phase !== 'ANSWER' || !!myPick} onClick={() => client.act({ type: 'pick', eventId: e.id })}>
                  <span>
                    {e.label}
                    {e.date && <span className="small muted"> · {e.date}</span>}
                  </span>
                  {earlier && <span className="verdict accent">First</span>}
                </button>
              );
            })}
          </div>
          {!v.inDuel && v.phase === 'ANSWER' && <Banner>Watching this duel.</Banner>}
          {v.phase !== 'ANSWER' && v.picks && (
            <div className="row small">
              {[v.initiator, v.opponent].map((m: string) => (
                <span key={m} className={`badge ${v.correct ? (v.correct[m] ? 'ok' : 'bad') : ''}`}>
                  {names[m]}: {v.correct ? (v.correct[m] ? 'correct' : 'wrong') : v.picks[m] ? 'locked' : '—'}
                </span>
              ))}
            </div>
          )}
        </>
      )}
      {v.voided && <Banner tone="warn">Duel voided</Banner>}
      <Attribution text={it?.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

// ---------------------------------------------------------------- TOP 25
export function Top25({ v, players }: ModeProps) {
  const names = useNames();
  const last = v.lastGuess;
  return (
    <div className="stage">
      <Head label={`TOP 25 · round ${v.round + 1}`} end={v.phase === 'TURN' ? v.phaseEnd : null} start={v.phaseStart} />
      <div>
        <h2 className="prompt">{v.title}</h2>
        <p className="muted small" style={{ margin: '4px 0 0' }}>{v.scope}. Rank #N = N points · first to {v.target} ends after the current round.</p>
      </div>
      <div className="row small">
        <span className="eyebrow">Snake order</span>
        {v.order.map((m: string) => (
          <span key={m} className={`badge ${m === v.player ? 'info' : ''}`}>{names[m]}</span>
        ))}
      </div>
      {v.phase === 'TURN' && (v.isMyTurn ? <TextAnswer disabled={false} onSubmit={(text) => client.act({ type: 'guess', text })} placeholder="Name someone on the list" cta="Guess" /> : <Banner>{names[v.player]} is guessing…</Banner>)}
      {last && (
        <Banner tone={last.rank && !last.duplicate ? 'ok' : 'bad'}>
          {names[last.player]}: “{last.text ?? '—'}” → {last.text === null ? "time's up" : last.duplicate ? 'already found (0)' : last.rank ? `#${last.rank} (+${last.rank})` : 'not on the list (0)'}
        </Banner>
      )}
      {v.endReason && <Banner tone="info">Finished: {v.endReason === 'TARGET' ? `${v.target} reached and the round completed` : v.endReason === 'EXHAUSTED' ? 'all 25 found' : 'round limit reached'}</Banner>}
      <div className="grid25" aria-label="Ranked list">
        {v.grid.map((c: any) => (
          <div key={c.rank} className={`cell25 ${c.foundBy ? 'found' : ''}`}>
            <span className="num">{c.rank}</span>
            <span className="truncate" style={{ flex: 1 }}>{c.label ?? <span className="muted">— hidden —</span>}</span>
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
  const names = useNames();
  const isJudge = role === 'JUDGE';
  const now = useGameNow();
  return (
    <div className="stage">
      <Head label="Buzzer Battle" index={v.itemIndex} count={v.itemCount} end={v.phase === 'ANSWERING' ? v.answerWindowEnd : v.phaseEnd} start={v.phaseStart} />
      <h2 className="prompt">{v.prompt}</h2>
      {isJudge && (
        <Banner tone="warn" icon="⚖">
          Answer key (judge only): <strong>{v.answer}</strong>
          {v.aliases?.length ? <span className="muted"> · also: {v.aliases.join(', ')}</span> : null}
        </Banner>
      )}
      {v.phase === 'ANSWERING' && (
        <Banner tone="info">
          <strong>{names[v.onFloor]}</strong> has the floor — answer out loud.
        </Banner>
      )}
      {isJudge && v.phase === 'ANSWERING' && (
        <div className="row">
          <button className="btn primary" onClick={() => client.act({ type: 'verdict', verdict: 'CORRECT' })}>Correct +3</button>
          <button className="btn danger" onClick={() => client.act({ type: 'verdict', verdict: 'WRONG' })}>Wrong −1</button>
          <button className="btn" disabled={now < v.answerWindowEnd} onClick={() => client.act({ type: 'verdict', verdict: 'TIMEOUT' })}>No answer in 8s</button>
        </div>
      )}
      {role === 'PLAYER' && v.phase !== 'REVEAL' && v.phase !== 'DONE' && (
        <button className="buzzer" disabled={!v.canBuzz} onClick={() => client.act({ type: 'buzz' })} aria-label="Buzz">
          {v.canBuzz ? 'Buzz' : v.lockedOut.includes(me) ? 'Used' : 'Wait'}
        </button>
      )}
      {v.phase === 'REVEAL' && <Banner tone="info">Answer: {v.answer}. {v.explanation}</Banner>}
      <div className="row small">
        {v.buzzes.map((b: any, i: number) => (
          <span key={i} className={`badge ${b.verdict === 'CORRECT' ? 'ok' : b.verdict ? 'bad' : 'info'}`}>
            {i + 1}. {names[b.player]} {b.verdict ? `· ${b.verdict.toLowerCase()}` : ''}
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
  const names = useNames();
  const phaseLabel: Record<string, string> = { REVEAL: 'Secret reveal', CLUES: `Clue cycle ${v.clueCycle ?? ''}`, DISCUSSION: 'Discussion', VOTE: 'Vote', GUESS: 'Impostor guess', ROUND_REVEAL: 'Round reveal', DONE: 'Finished' };
  return (
    <div className="stage">
      <Head label={`The Impostor · ${phaseLabel[v.phase]}`} index={v.round} count={v.roundCount} end={v.phaseEnd} start={v.phaseStart} />
      {v.role === 'IMPOSTOR' && v.phase !== 'ROUND_REVEAL' && v.phase !== 'DONE' && (
        <div className="card" style={{ borderColor: 'var(--danger)', textAlign: 'center' }}>
          <div className="display h2" style={{ color: 'var(--danger)' }}>You are the impostor</div>
          <p className="muted">You don’t know the footballer. Blend in with your clues.</p>
        </div>
      )}
      {v.role === 'CREW' && v.phase !== 'ROUND_REVEAL' && v.phase !== 'DONE' && (
        <div className="card pitch" style={{ textAlign: 'center' }}>
          <div className="eyebrow">Secret footballer</div>
          <div className="display h2 accent">{v.footballer}</div>
          <p className="muted small">{v.context}</p>
        </div>
      )}
      {role !== 'PLAYER' && v.phase !== 'ROUND_REVEAL' && <Banner>The secret footballer is hidden from {role === 'JUDGE' ? 'judges' : 'spectators'}.</Banner>}
      {v.phase === 'CLUES' && (
        <div className="row">
          <Avatar id={v.clueGiver} name={names[v.clueGiver] ?? '?'} />
          <strong>{v.clueGiver === me ? 'Your clue — say it out loud' : `${names[v.clueGiver]} is giving a clue`}</strong>
          {v.clueGiver === me && <button className="btn sm" onClick={() => client.act({ type: 'clueDone' })}>Done</button>}
        </div>
      )}
      {v.phase === 'DISCUSSION' && <Banner>Discuss out loud: who is bluffing?</Banner>}
      {v.phase === 'VOTE' && role === 'PLAYER' && (
        <div className="stack">
          <div className="eyebrow">{v.myVote ? `You voted for ${names[v.myVote]}` : 'Vote for the impostor'}</div>
          <div className="options">
            {players.filter((p) => p !== me).map((p) => (
              <button key={p} className={`option ${v.myVote === p ? 'picked' : ''}`} disabled={!!v.myVote} onClick={() => client.act({ type: 'vote', target: p })}>
                <Avatar id={p} name={names[p] ?? '?'} /> {names[p]}
              </button>
            ))}
          </div>
          <p className="small muted" style={{ margin: 0 }}>{v.voted.length}/{players.length} voted. Votes stay private until the reveal.</p>
        </div>
      )}
      {v.phase === 'GUESS' && (
        <>
          <Banner tone="warn">{names[v.impostor]} was caught! They get one guess at the footballer.</Banner>
          {v.role === 'IMPOSTOR' && <TextAnswer disabled={false} onSubmit={(text) => client.act({ type: 'guess', text })} placeholder="Who is the footballer?" cta="Guess" />}
        </>
      )}
      {v.phase === 'ROUND_REVEAL' && (
        <div className="card stack">
          <div>
            The footballer was <strong className="accent">{v.footballer}</strong>. The impostor was <strong>{names[v.impostor]}</strong> — {v.caught ? 'caught' : 'escaped'}.
          </div>
          {v.caught && <div>Guess: “{v.guess ?? '—'}” {v.guessCorrect ? '✓ correct' : '✕ wrong'}</div>}
          <div className="row small">
            {Object.entries(v.votes ?? {}).map(([voter, target]) => (
              <span key={voter} className={`badge ${target === v.impostor ? 'ok' : ''}`}>
                {names[voter]} → {names[target as string]}
              </span>
            ))}
          </div>
          <div className="row small">
            {Object.entries(v.roundPoints ?? {}).map(([m, pts]) => (
              <span key={m} className="badge info">
                {names[m]} +{String(pts)}
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
  const names = useNames();
  const [amount, setAmount] = useState<number>(Math.max(1, (v.bid ?? 0) + 1));
  const myTurn = role === 'PLAYER' && v.turn === me;
  const min = (v.bid ?? 0) + 1;
  const isJudge = role === 'JUDGE';
  const [name, setName] = useState('');
  return (
    <div className="stage">
      <Head label={`Auction · ${v.phase === 'CHALLENGE' ? '30 seconds' : v.phase === 'BIDDING' ? 'Bidding' : v.phase === 'AWAIT_JUDGE' ? 'Ready' : 'Result'}`} index={v.round} count={v.roundCount} end={v.phaseEnd} start={v.phaseStart} />
      <div>
        <h2 className="prompt">{v.category}</h2>
        <p className="muted small" style={{ margin: '4px 0 0' }}>{v.scope} · max bid {v.maxBid}</p>
      </div>
      <div className="row">
        <span className="badge info">Current bid: {v.bid || '—'} {v.bidder ? `by ${names[v.bidder]}` : ''}</span>
        {v.challenger && <span className="badge warn">Challenger: {names[v.challenger]}</span>}
      </div>
      {v.phase === 'BIDDING' && (
        myTurn ? (
          <div className="card stack">
            <div className="eyebrow">Your bid</div>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <button className="btn" aria-label="Decrease" onClick={() => setAmount(Math.max(min, amount - 1))}>−</button>
              <span className="num" style={{ fontSize: 40, minWidth: 60, textAlign: 'center' }} aria-live="polite">{Math.max(amount, min)}</span>
              <button className="btn" aria-label="Increase" onClick={() => setAmount(Math.min(v.maxBid, Math.max(amount, min) + 1))}>+</button>
              <button className="btn primary" onClick={() => client.act({ type: 'bid', amount: Math.max(amount, min) })}>Bid</button>
              {v.bidder && <button className="btn danger" onClick={() => client.act({ type: 'drop' })}>Drop</button>}
            </div>
          </div>
        ) : (
          <Banner>{names[v.turn]} is deciding…</Banner>
        )
      )}
      {(v.phase === 'AWAIT_JUDGE' || v.phase === 'CHALLENGE') && (
        <div className="card" style={{ textAlign: 'center' }}>
          <div className="eyebrow">{names[v.bidder]} must name {v.bid}</div>
          <div className="num" style={{ fontSize: 72 }} aria-live="polite">{v.count} / {v.bid}</div>
          {v.phase === 'AWAIT_JUDGE' && <p className="muted">The 30s starts on the judge’s first valid tap.</p>}
        </div>
      )}
      {isJudge && (v.phase === 'AWAIT_JUDGE' || v.phase === 'CHALLENGE') && (
        <div className="card stack">
          <div className="eyebrow">Judge counter</div>
          <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={(e) => { e.preventDefault(); void client.act({ type: 'tap', ...(name.trim() ? { name: name.trim() } : {}) }); setName(''); }}>
            <input className="input" placeholder="Name heard (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn primary">Valid +1</button>
          </form>
          <button className="btn" disabled={v.count === 0} onClick={() => client.act({ type: 'undo' })}>Undo last (timer keeps running)</button>
          <details>
            <summary className="small muted">Verified answer universe ({v.universe?.length})</summary>
            <p className="small" style={{ columns: 2 }}>{v.universe?.join(' · ')}</p>
          </details>
        </div>
      )}
      {v.phase === 'ROUND_REVEAL' && (
        <Banner tone={v.outcome === 'SUCCESS' ? 'ok' : 'bad'}>
          {v.outcome === 'SUCCESS' ? `${names[v.bidder]} did it: +5` : `${names[v.bidder]} fell short: −2 · ${names[v.challenger] ?? 'challenger'} +5`}
        </Banner>
      )}
      <Attribution text={v.attribution} />
      <ScoreStrip scores={v.scores} players={players} />
    </div>
  );
}

export function ModeView(props: ModeProps & { runKey: string }) {
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
      return <Mcq {...props} label="Championship tie-break · 15s · no speed bonus" />;
    default:
      return <Banner tone="bad">Unknown mode</Banner>;
  }
}
