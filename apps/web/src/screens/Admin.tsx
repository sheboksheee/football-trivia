/* eslint-disable @typescript-eslint/no-explicit-any -- admin API payloads */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Banner, Empty, Modal, Skeleton } from '../ui/common.js';

const TOKEN_KEY = 'ft.adminToken';
const STATUSES = [
  'NEEDS_REVIEW',
  'PUBLISHED',
  'QUARANTINED',
  'BLOCKED_RIGHTS',
  'REJECTED',
  'DUPLICATE',
  'NEEDS_EVIDENCE',
  'RETIRED',
];
const KINDS = [
  'mcq',
  'higher_lower',
  'short_answer',
  'connection',
  'timeline',
  'impostor',
  'missing_xi',
  'guess_match',
  'top25',
  'auction',
];
const tone = (s: string) =>
  s === 'PUBLISHED'
    ? 'ok'
    : s === 'NEEDS_REVIEW'
      ? 'info'
      : s === 'RETIRED'
        ? ''
        : s === 'QUARANTINED' || s === 'BLOCKED_RIGHTS'
          ? 'bad'
          : 'warn';

function useAdmin(token: string) {
  return useCallback(
    async (path: string, init?: RequestInit) => {
      const r = await fetch(`/api/admin${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      return body;
    },
    [token],
  );
}

export function Admin() {
  const [token, setToken] = useState(() => {
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [draft, setDraft] = useState('');
  const [authErr, setAuthErr] = useState<string | null>(null);
  const api = useAdmin(token);
  const [summary, setSummary] = useState<any>(null);
  const [tab, setTab] = useState<'queue' | 'sources' | 'conflicts'>('queue');

  useEffect(() => {
    if (!token) return;
    api('/summary')
      .then((s) => {
        setSummary(s);
        setAuthErr(null);
      })
      .catch((e) => {
        setAuthErr(e.message);
        setSummary(null);
      });
  }, [token, api]);

  const login = (e: FormEvent) => {
    e.preventDefault();
    try {
      sessionStorage.setItem(TOKEN_KEY, draft.trim());
    } catch {
      /* ignore */
    }
    setToken(draft.trim());
  };

  if (!token || authErr) {
    return (
      <form className="card stack" style={{ maxWidth: 460, margin: '0 auto' }} onSubmit={login}>
        <h1 className="display h2">Content studio</h1>
        <p className="muted" style={{ margin: 0 }}>
          Review, publish and retire questions. Every decision is audited. Enter the server’s admin token — on
          Render: your service → Environment → ADMIN_TOKEN (click the eye icon); in local development it is
          printed in the server log.
        </p>
        {authErr && <Banner tone="bad">{authErr}</Banner>}
        <div className="field">
          <label className="label" htmlFor="tok">
            Admin token
          </label>
          <input
            id="tok"
            className="input"
            type="password"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <button className="btn primary" disabled={!draft}>
          Sign in
        </button>
      </form>
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <h1 className="display h2" style={{ margin: 0 }}>
          Content studio
        </h1>
        <span className="spacer" />
        <button
          className="btn ghost sm"
          onClick={() => {
            sessionStorage.removeItem(TOKEN_KEY);
            setToken('');
          }}
        >
          Sign out
        </button>
      </div>
      <Banner tone="warn">
        Questions from “Synthetic Dev League” are fictional test data (made-up clubs and players). Real
        questions come from football-data.org: they appear under Source → football-data.org once the server
        has a FOOTBALL_DATA_API_KEY, after you record the license in Sources &amp; rights and approve them
        here. When enough real questions are published, games use them first.
      </Banner>
      {summary ? <Summary counts={summary.counts} conflicts={summary.conflicts} /> : <Skeleton h={90} />}
      <div className="seg" role="tablist" style={{ maxWidth: 520 }}>
        {(['queue', 'sources', 'conflicts'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-pressed={tab === k}
            aria-selected={tab === k}
            onClick={() => setTab(k)}
          >
            {k === 'queue' ? 'Questions' : k === 'sources' ? 'Sources & rights' : 'Conflicts'}
          </button>
        ))}
      </div>
      {tab === 'queue' && <Queue api={api} onChange={() => api('/summary').then(setSummary)} />}
      {tab === 'sources' && <Sources api={api} />}
      {tab === 'conflicts' && <Conflicts api={api} />}
    </div>
  );
}

function Summary({
  counts,
  conflicts,
}: {
  counts: Record<string, Record<string, number>>;
  conflicts: number;
}) {
  const total = (s: string) => Object.values(counts).reduce((a, c) => a + (c[s] ?? 0), 0);
  return (
    <div className="modes">
      {['PUBLISHED', 'NEEDS_REVIEW', 'QUARANTINED', 'BLOCKED_RIGHTS', 'REJECTED'].map((s) => (
        <div key={s} className="card tight">
          <div className="eyebrow">{s.replace('_', ' ')}</div>
          <div className="num" style={{ fontSize: 36 }}>
            {total(s)}
          </div>
        </div>
      ))}
      <div className="card tight">
        <div className="eyebrow">Source conflicts</div>
        <div className="num" style={{ fontSize: 36 }}>
          {conflicts}
        </div>
      </div>
    </div>
  );
}

function Queue({ api, onChange }: { api: ReturnType<typeof useAdmin>; onChange: () => void }) {
  const [status, setStatus] = useState('QUARANTINED');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [bulkNote, setBulkNote] = useState('');
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    setData(null);
    const p = new URLSearchParams({ limit: '100' });
    if (status) p.set('status', status);
    if (kind) p.set('kind', kind);
    if (q) p.set('q', q);
    if (source) p.set('source', source);
    api(`/questions?${p}`)
      .then(setData)
      .catch((e) => setErr(e.message));
  }, [api, status, kind, q, source]);
  const bulkApprove = async () => {
    if (!data?.items?.length) return;
    try {
      const r = await api('/questions/bulk-review', {
        method: 'POST',
        body: JSON.stringify({ ids: data.items.map((x: any) => x.id), action: 'APPROVE', note: bulkNote }),
      });
      setBulkMsg(`Approved ${r.done}${r.failed.length ? `, ${r.failed.length} refused by gates` : ''}`);
      setBulkNote('');
      load();
      onChange();
    } catch (e) {
      setBulkMsg((e as Error).message);
    }
  };
  useEffect(load, [load]);
  return (
    <section className="card stack">
      <div className="row">
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All kinds</option>
          {KINDS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 'auto' }}
          aria-label="Source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">All sources</option>
          <option value="src_football_data_org">football-data.org (real)</option>
          <option value="src_synthetic_dev_league">Fictional dev league</option>
        </select>
        <input
          className="input"
          style={{ flex: 1, minWidth: 160 }}
          placeholder="Search text or id"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
        />
      </div>
      {err && <Banner tone="bad">{err}</Banner>}
      {!data && !err && (
        <>
          <Skeleton h={52} />
          <Skeleton h={52} />
          <Skeleton h={52} />
        </>
      )}
      {data && data.items.length === 0 && (
        <Empty title="Nothing here">No questions match these filters.</Empty>
      )}
      {data && data.items.length > 0 && (
        <>
          <p className="small muted" style={{ margin: 0 }}>
            {data.total} matching · showing {data.items.length}
          </p>
          {status === 'NEEDS_REVIEW' && (
            <div className="card tight stack" style={{ background: 'var(--bg-2)' }}>
              <span className="small">
                Approve all {data.items.length} shown questions at once. Each one is re-checked against every
                gate and gets its own audit entry. Only do this after spot-checking a few against the source.
              </span>
              <div className="row">
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 200 }}
                  placeholder="Review note (required)"
                  value={bulkNote}
                  onChange={(e) => setBulkNote(e.target.value)}
                />
                <button
                  className="btn primary sm"
                  disabled={bulkNote.trim().length < 3}
                  onClick={bulkApprove}
                >
                  Approve {data.items.length} shown
                </button>
              </div>
              {bulkMsg && <span className="small muted">{bulkMsg}</span>}
            </div>
          )}
          <ul className="list">
            {data.items.map((it: any) => (
              <li key={it.id}>
                <button
                  className="list-item"
                  style={{ width: '100%', textAlign: 'start', cursor: 'pointer' }}
                  onClick={() => setSelected(it.id)}
                >
                  <span className="grow">
                    <span className="truncate" style={{ display: 'block' }}>
                      {it.summary}
                    </span>
                    <span className="small muted">
                      {it.kind} · {it.template} · {it.difficulty.toLowerCase()} (
                      {it.difficultyStatus.toLowerCase()})
                    </span>
                    {it.failing.length > 0 && (
                      <span className="small" style={{ display: 'block', color: 'var(--warn)' }}>
                        {it.failing.join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className={`badge ${tone(it.status)}`}>{it.status.replace('_', ' ')}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {selected && (
        <Detail
          api={api}
          id={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            load();
            onChange();
          }}
        />
      )}
    </section>
  );
}

function Detail({
  api,
  id,
  onClose,
  onChanged,
}: {
  api: ReturnType<typeof useAdmin>;
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<any>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api(`/questions/${id}`)
      .then(setD)
      .catch((e) => setErr(e.message));
  }, [api, id]);
  const act = async (action: string) => {
    setErr(null);
    try {
      const r = await api(`/questions/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, note }),
      });
      setD((x: any) => ({ ...x, question: r.question }));
      setNote('');
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const q = d?.question;
  const allowed: Record<string, string[]> = {
    NEEDS_REVIEW: ['APPROVE', 'REJECT', 'QUARANTINE'],
    PUBLISHED: ['RETIRE', 'QUARANTINE', 'REJECT'],
    QUARANTINED: ['REJECT'],
    RETIRED: ['RESTORE'],
  };
  return (
    <Modal title="Question detail" onClose={onClose}>
      {!d && !err && <Skeleton h={200} />}
      {err && <Banner tone="bad">{err}</Banner>}
      {q && (
        <div className="stack" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <div className="row">
            <span className={`badge ${tone(q.status)}`}>{q.status}</span>
            <span className="badge">{q.kind}</span>
            <span className="badge">v{q.version}</span>
            {q.highImpact && <span className="badge warn">high impact</span>}
          </div>
          <pre
            className="mono card tight"
            style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 180, overflow: 'auto' }}
          >
            {JSON.stringify(q.item, null, 1)}
          </pre>
          <div className="eyebrow">Gates</div>
          <ul className="list">
            {q.gates.map((g: any, i: number) => (
              <li key={i} className="list-item small">
                <span className={`badge ${g.passed ? 'ok' : 'bad'}`}>
                  {g.passed ? 'pass' : g.failureStatus}
                </span>
                <span className="grow">
                  {g.gate}: {g.message}
                </span>
              </li>
            ))}
          </ul>
          <div className="eyebrow">Difficulty</div>
          <p className="small" style={{ margin: 0 }}>
            Estimate {q.difficulty.estimate}/100 → {q.difficulty.tier} ({q.difficulty.status});{' '}
            {q.difficulty.attempts} attempts. Weights are unvalidated starting hypotheses.
          </p>
          <div className="eyebrow">Evidence ({d.totalFacts} facts)</div>
          <ul className="list">
            {d.facts.slice(0, 8).map((f: any) => (
              <li key={f.id} className="list-item small" style={{ display: 'block' }}>
                <div>
                  <strong>{f.subject}</strong> · {f.predicate} = {String(f.value)}{' '}
                  <span className={`badge ${f.status === 'CONFLICTED' ? 'bad' : ''}`}>{f.status}</span>
                </div>
                <div className="muted">
                  {f.scope.competition} {f.scope.season ?? ''} · cutoff {f.scope.cutoff} · {f.sourceId}
                </div>
                {f.evidence && (
                  <div className="mono muted">
                    snapshot {f.evidence.id} · sha256 {f.evidence.hash.slice(0, 16)}…
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="eyebrow">Audit trail</div>
          <ul className="list small">
            {q.audit.map((a: any, i: number) => (
              <li key={i} className="muted">
                {a.at.slice(0, 19)} · {a.actor} · {a.action} → {a.toStatus}: {a.note}
              </li>
            ))}
          </ul>
          {(allowed[q.status] ?? []).length > 0 ? (
            <div className="stack">
              <input
                className="input"
                placeholder="Review note (required)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="row">
                {(allowed[q.status] ?? []).map((a) => (
                  <button
                    key={a}
                    className={`btn sm ${a === 'APPROVE' ? 'primary' : a === 'REJECT' || a === 'QUARANTINE' ? 'danger' : ''}`}
                    disabled={note.trim().length < 3}
                    onClick={() => act(a)}
                  >
                    {a.toLowerCase()}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Banner>
              {q.status === 'BLOCKED_RIGHTS'
                ? 'Blocked until the source license is approved. Review cannot override rights.'
                : 'No review action available for this status.'}
            </Banner>
          )}
        </div>
      )}
    </Modal>
  );
}

function Sources({ api }: { api: ReturnType<typeof useAdmin> }) {
  const [s, setS] = useState<any[] | null>(null);
  const [fd, setFd] = useState<any>(null);
  const [od, setOd] = useState<any>(null);
  const load = useCallback(() => {
    api('/sources')
      .then((r) => {
        setS(r.sources);
        setFd(r.footballData);
        setOd(r.openData);
      })
      .catch(() => setS([]));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!fd?.running && !od?.running) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [fd?.running, od?.running, load]);
  if (!s) return <Skeleton h={200} />;
  const real = s.find((x) => x.id === 'src_football_data_org');
  return (
    <div className="stack">
      {real && <FootballDataPanel api={api} source={real} status={fd} onChange={load} />}
      <OpenDataPanel
        api={api}
        sources={s.filter((x) => x.id === 'src_wikidata' || x.id === 'src_openfootball')}
        status={od}
        onChange={load}
      />
      <section className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>License</th>
                <th>Integrated</th>
              </tr>
            </thead>
            <tbody>
              {s.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>{x.name}</strong>
                    <div className="small muted">{x.notes}</div>
                    {x.termsUrl && (
                      <a className="small" href={x.termsUrl} target="_blank" rel="noreferrer noopener">
                        {x.termsUrl}
                      </a>
                    )}
                  </td>
                  <td className="small">{x.kind}</td>
                  <td>
                    <span className={`badge ${x.licenseStatus === 'APPROVED' ? 'ok' : 'warn'}`}>
                      {x.licenseStatus}
                    </span>
                    {x.allowedUses?.length > 0 && (
                      <div className="small muted">{x.allowedUses.join(', ')}</div>
                    )}
                  </td>
                  <td>{x.integrated ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function FootballDataPanel({
  api,
  source,
  status,
  onChange,
}: {
  api: ReturnType<typeof useAdmin>;
  source: any;
  status: any;
  onChange: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const ingest = async () => {
    try {
      await api('/football-data/ingest', { method: 'POST', body: '{}' });
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const last = status?.lastReport;
  return (
    <section className="card stack">
      <h2 className="display h3" style={{ margin: 0 }}>
        football-data.org (real data)
      </h2>
      {!status?.enabled ? (
        <Banner tone="warn">
          Not connected on this server. Set <span className="mono">FOOTBALL_DATA_API_KEY</span> (your token
          from football-data.org) in the server environment and restart.
        </Banner>
      ) : (
        <div className="row small">
          <span className={`badge ${status.running ? 'info' : 'ok'}`}>
            {status.running ? 'Fetching…' : 'Idle'}
          </span>
          <span>{status.snapshots} stored responses</span>
          <span className="muted">
            {status.competitions.join(', ')} · seasons {status.seasons.join(', ')}
          </span>
          <span className="spacer" />
          <button className="btn sm" disabled={status.running} onClick={ingest}>
            Fetch missing data
          </button>
        </div>
      )}
      {last && (
        <p className="small muted" style={{ margin: 0 }}>
          Last run {status.lastRunAt?.slice(0, 16).replace('T', ' ')}: {last.added} new responses,{' '}
          {last.calls} API calls
          {last.skipped.length > 0 &&
            ` · ${last.skipped.length} skipped (${[...new Set(last.skipped.map((x: any) => x.reason))].join(', ')})`}
          {last.error && ` · error: ${last.error}`}
        </p>
      )}
      {last?.skipped?.some((x: any) => x.reason === 'UNAUTHORIZED') && (
        <Banner tone="bad">
          football-data.org rejected the API token (
          {last.skipped.find((x: any) => x.reason === 'UNAUTHORIZED')?.detail ?? 'unauthorized'}). If you
          generated a new token, update FOOTBALL_DATA_API_KEY on the server, restart it, then press “Fetch
          missing data”.
        </Banner>
      )}
      {last?.skipped?.some((x: any) => x.reason === 'NETWORK') && (
        <Banner tone="bad">
          The server could not reach api.football-data.org (network). Try again later.
        </Banner>
      )}
      <LicenseControl api={api} source={source} onChange={onChange} />
      {msg && <span className="small muted">{msg}</span>}
    </section>
  );
}

function LicenseControl({
  api,
  source,
  onChange,
}: {
  api: ReturnType<typeof useAdmin>;
  source: any;
  onChange: () => void;
}) {
  const current: 'PENDING' | 'TESTING' | 'COMMERCIAL' | 'DENIED' =
    source.licenseStatus !== 'APPROVED'
      ? source.licenseStatus
      : source.allowedUses.includes('COMMERCIAL_REDISTRIBUTION')
        ? 'COMMERCIAL'
        : 'TESTING';
  const [decision, setDecision] = useState(current);
  const LABEL = {
    PENDING: 'Pending',
    TESTING: 'Private testing',
    COMMERCIAL: 'Commercial',
    DENIED: 'Denied',
  } as const;
  const unchanged = decision === current;
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    const body =
      decision === 'TESTING'
        ? { status: 'APPROVED', allowedUses: ['GAMEPLAY'] }
        : decision === 'COMMERCIAL'
          ? { status: 'APPROVED', allowedUses: ['GAMEPLAY', 'COMMERCIAL_REDISTRIBUTION'] }
          : { status: decision, allowedUses: [] };
    try {
      await api(`/sources/${source.id}/license`, { method: 'POST', body: JSON.stringify({ ...body, note }) });
      setMsg('Saved. Questions were re-checked against the new license.');
      setNote('');
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <>
      <div className="field">
        <span className="label">License decision (recorded with your note in an audit trail)</span>
        <div className="seg" role="group" aria-label="License decision">
          {(
            [
              ['PENDING', 'Pending'],
              ['TESTING', 'Private testing'],
              ['COMMERCIAL', 'Commercial (confirmed in writing)'],
              ['DENIED', 'Denied'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={decision === k} onClick={() => setDecision(k)}>
              {label}
            </button>
          ))}
        </div>
        <span className="small muted">
          Private testing lets approved questions be played in demo/dev servers. A production launch only uses
          sources marked Commercial. Real questions always need your approval in the Questions tab — nothing
          is auto-published.
        </span>
      </div>
      <div className="row">
        <input
          className="input"
          style={{ flex: 1, minWidth: 200 }}
          placeholder="Evidence / note (e.g. plan name, email confirmation)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="btn primary sm" disabled={unchanged || note.trim().length < 3} onClick={save}>
          {unchanged ? `Current: ${LABEL[current]}` : `Save as “${LABEL[decision]}”`}
        </button>
      </div>
      {unchanged && (
        <span className="small muted">
          Pick a different decision above to change the license (currently {LABEL[current]}).
        </span>
      )}
      {msg && <span className="small muted">{msg}</span>}
      {source.licenseHistory?.length > 0 && (
        <ul className="list small">
          {source.licenseHistory.map((h: any, i: number) => (
            <li key={i} className="muted">
              {h.at.slice(0, 16).replace('T', ' ')} · {h.by} · {h.status} {h.allowedUses.join('+')} — {h.note}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function OpenDataPanel({
  api,
  sources,
  status,
  onChange,
}: {
  api: ReturnType<typeof useAdmin>;
  sources: any[];
  status: any;
  onChange: () => void;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const ingest = async () => {
    try {
      await api('/open-data/ingest', { method: 'POST', body: '{}' });
      onChange();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const last = status?.lastReport;
  const cc = status?.crossCheck;
  return (
    <section className="card stack">
      <h2 className="display h3" style={{ margin: 0 }}>
        Open data (CC0): Wikidata + OpenFootball
      </h2>
      <p className="small muted" style={{ margin: 0 }}>
        Wikidata adds club careers of well-known players (Impostor, Connections, “which club did he play
        for?”). OpenFootball re-reports league results: any score that disagrees with football-data.org is
        quarantined automatically.
      </p>
      {!status?.enabled ? (
        <Banner tone="warn">Disabled on this server (OPEN_DATA_ENABLED=false).</Banner>
      ) : (
        <div className="row small">
          <span className={`badge ${status.running ? 'info' : 'ok'}`}>
            {status.running ? 'Fetching…' : 'Idle'}
          </span>
          <span>
            {status.snapshots.wikidata} Wikidata · {status.snapshots.openFootball} OpenFootball responses
          </span>
          <span className="spacer" />
          <button className="btn sm" disabled={status.running} onClick={ingest}>
            Fetch missing data
          </button>
        </div>
      )}
      {last && (
        <p className="small muted" style={{ margin: 0 }}>
          Last run {status.lastRunAt?.slice(0, 16).replace('T', ' ')}: Wikidata {last.wikidata.added} new (
          {last.wikidata.calls} calls), OpenFootball {last.openFootball.added} new
          {[...last.wikidata.skipped, ...last.openFootball.skipped].length > 0 &&
            ` · skipped: ${[...new Set([...last.wikidata.skipped, ...last.openFootball.skipped].map((x: any) => x.reason))].join(', ')}`}
          {last.error && ` · error: ${last.error}`}
        </p>
      )}
      {cc && (
        <Banner tone={cc.conflicts ? 'warn' : 'ok'}>
          Cross-check: {cc.compared} matches compared, {cc.agreed} agree, {cc.conflicts} disagree
          (quarantined)
          {cc.unmatchedTeams.length > 0 && ` · unmatched names: ${cc.unmatchedTeams.slice(0, 6).join(', ')}`}
        </Banner>
      )}
      {sources.map((src) => (
        <div key={src.id} className="stack" style={{ gap: 8 }}>
          <strong className="small">{src.name}</strong>
          <LicenseControl api={api} source={src} onChange={onChange} />
        </div>
      ))}
      {msg && <span className="small muted">{msg}</span>}
    </section>
  );
}

function Conflicts({ api }: { api: ReturnType<typeof useAdmin> }) {
  const [c, setC] = useState<any[] | null>(null);
  useEffect(() => {
    api('/conflicts')
      .then((r) => setC(r.conflicts))
      .catch(() => setC([]));
  }, [api]);
  if (!c) return <Skeleton h={200} />;
  if (c.length === 0) return <Empty title="No conflicts">All sources agree.</Empty>;
  return (
    <section className="card stack">
      <p className="small muted" style={{ margin: 0 }}>
        Facts where sources disagree. Every dependent question is quarantined; resolution requires an
        authoritative primary source — never a model’s guess.
      </p>
      <ul className="list">
        {c.map((x) => (
          <li key={x.key} className="list-item small" style={{ display: 'block' }}>
            <div className="mono">{x.key}</div>
            <div className="row">
              {x.values.map((v: any, i: number) => (
                <span key={i} className="badge bad">
                  {v.sourceId}: {String(v.value)}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
