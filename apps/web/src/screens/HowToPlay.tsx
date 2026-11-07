import { MODES, MODE_KEYS } from '@ft/shared';

export function HowToPlay() {
  return (
    <div className="stack">
      <h1 className="display h2">How to play</h1>
      <section className="card stack">
        <h2 className="display h3">Match Night</h2>
        <p style={{ margin: 0 }}>A playlist of modes (Quick 3, Classic 5, Custom 2–12, or a single mode). Each mode has its own scoring; its final ranking converts to championship placement points: <strong>1st 5 · 2nd 3 · 3rd 1 · 4th+ 0</strong>. Tied places share the occupied places exactly — two players tied for 1st get (5+3)/2 = 4 each; three tied for 2nd get 4/3 each.</p>
        <p style={{ margin: 0 }}>Champion ladder: total placement points → most sole 1st places → sole 2nds → sole 3rds → up to five simultaneous 15-second tie-break questions (no speed bonus). Still tied: shared champions.</p>
        <p style={{ margin: 0 }} className="muted">Fairness: the server runs every clock, grades every answer and keeps answers hidden until the reveal. A 15-second appeal window follows each result; your original answer and timestamp can’t be edited. Disconnected? You have 30 seconds to rejoin your seat — timers never extend.</p>
      </section>
      <div className="modes">
        {MODE_KEYS.map((k) => {
          const m = MODES[k];
          return (
            <article key={k} className="card stack" style={{ gap: 8 }}>
              <div className="row">
                <span className="eyebrow">{String(m.number).padStart(2, '0')}</span>
                <span className="spacer" />
                <span className={`badge ${m.rulesStatus === 'APPROVED' ? 'ok' : m.rulesStatus === 'PROVISIONAL' ? 'warn' : 'bad'}`}>{m.rulesStatus.toLowerCase()}</span>
              </div>
              <h2 className="display h3" style={{ margin: 0 }}>{m.name.en} <span className="muted small" lang="ar" dir="rtl">{m.name.ar}</span></h2>
              <p className="small" style={{ margin: 0 }}>{m.concept}</p>
              <p className="small muted" style={{ margin: 0 }}>{m.rules}</p>
              <p className="small muted" style={{ margin: 0 }}>{m.minPlayers}–{m.maxPlayers} players{m.judge === 'required' ? ' · needs a neutral judge' : m.judge === 'optional' ? ' · judge optional' : ''}</p>
              {m.proposed.length > 0 && (
                <details>
                  <summary className="small">Proposed parameters (awaiting approval)</summary>
                  <ul className="small muted">{m.proposed.map((p) => <li key={p}>{p}</li>)}</ul>
                </details>
              )}
              {m.blockers.length > 0 && <ul className="small" style={{ color: 'var(--danger)' }}>{m.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
