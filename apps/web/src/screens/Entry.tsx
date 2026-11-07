import { useState, type FormEvent } from 'react';
import { DisplayName, isInviteCode } from '@ft/shared';
import { useI18n } from '../i18n.js';
import { client } from '../net/client.js';

const NAME_KEY = 'ft.name';
const storedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
};

export function Entry({ mode, go, initialCode }: { mode: 'create' | 'join'; go: (r: string) => void; initialCode?: string }) {
  const { t, locale } = useI18n();
  const [name, setName] = useState(storedName);
  const [code, setCode] = useState(initialCode ?? '');
  const [role, setRole] = useState<'PLAYER' | 'JUDGE' | 'SPECTATOR'>('PLAYER');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    const n = DisplayName.safeParse(name);
    if (!n.success) return setErr(n.error.issues[0]?.message ?? 'Invalid name');
    const c = code.trim().toUpperCase();
    if (mode === 'join' && !isInviteCode(c)) return setErr('Codes are 6 letters/numbers (no 0, O, 1, I or L)');
    setBusy(true);
    try {
      localStorage.setItem(NAME_KEY, n.data);
    } catch {
      /* ignore */
    }
    try {
      await client.connect();
      const ack = mode === 'create' ? await client.send({ type: 'room.create', payload: { displayName: n.data, locale } }) : await client.send({ type: 'room.join', payload: { code: c, displayName: n.data, role } });
      if (!ack.ok) {
        setErr(ack.error?.message ?? t('error'));
        return;
      }
      const room = client.snap.roomCode;
      go(`#/room/${room}`);
    } catch {
      setErr('Cannot reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card stack" style={{ maxWidth: 480, margin: '0 auto' }} onSubmit={submit} noValidate>
      <h1 className="display h2">{mode === 'create' ? t('playNow') : t('joinWithCode')}</h1>
      <div className="field">
        <label className="label" htmlFor="name">{t('yourName')}</label>
        <input id="name" className="input" value={name} maxLength={24} autoComplete="nickname" onChange={(e) => setName(e.target.value)} required />
      </div>
      {mode === 'join' && (
        <>
          <div className="field">
            <label className="label" htmlFor="code">{t('roomCode')}</label>
            <input id="code" className="input code" value={code} maxLength={6} inputMode="text" autoCapitalize="characters" autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} required />
          </div>
          <div className="field">
            <span className="label" id="role-label">{t('joinAs')}</span>
            <div className="seg" role="group" aria-labelledby="role-label">
              {(['PLAYER', 'JUDGE', 'SPECTATOR'] as const).map((r) => (
                <button type="button" key={r} aria-pressed={role === r} onClick={() => setRole(r)}>
                  {t(r === 'PLAYER' ? 'player' : r === 'JUDGE' ? 'judge' : 'spectator')}
                </button>
              ))}
            </div>
            <span className="small muted">
              {role === 'JUDGE' ? 'Neutral referee: rules on spoken answers and appeals. Judges never play.' : role === 'SPECTATOR' ? 'Watch the public game. Answers, votes and secret roles stay hidden.' : 'Compete for the Match Night title (2–6 players).'}
            </span>
          </div>
        </>
      )}
      {err && <p className="field-error" role="alert">{err}</p>}
      <div className="row">
        <button type="button" className="btn ghost" onClick={() => go('#/')}>{t('back')}</button>
        <span className="spacer" />
        <button className="btn primary" disabled={busy}>{busy ? '…' : mode === 'create' ? t('create') : t('join')}</button>
      </div>
    </form>
  );
}
