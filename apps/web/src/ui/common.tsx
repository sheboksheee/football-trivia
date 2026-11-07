import { useEffect, useRef, type ReactNode } from 'react';
import type { RoomView } from '@ft/game-rules';
import { Fraction } from '@ft/shared';
import { useGame, useRemaining } from '../net/hooks.js';
import { client } from '../net/client.js';
import { useI18n } from '../i18n.js';

const AVATAR_COLORS = ['#B7FF43', '#6CC6FF', '#FFC94A', '#FF8FB1', '#C9A7FF', '#7DF0D0'];

export function memberNames(view: RoomView | null): Record<string, string> {
  return Object.fromEntries((view?.members ?? []).map((m) => [m.id, m.name]));
}
export function memberColor(view: RoomView | null, id: string): string {
  const idx = (view?.members ?? []).findIndex((m) => m.id === id);
  return AVATAR_COLORS[(idx < 0 ? 0 : idx) % AVATAR_COLORS.length]!;
}

export function Avatar({ id, name, size = 36 }: { id: string; name: string; size?: number }) {
  const { view } = useGame();
  return (
    <span className="avatar" aria-hidden="true" style={{ background: memberColor(view, id), width: size, height: size, fontSize: size * 0.48 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Server-driven countdown. Turns amber when the server clock is frozen (pause / appeal hold). */
export function Timer({ end, start, label }: { end: number | null | undefined; start?: number | null; label?: string }) {
  const { view } = useGame();
  const rem = useRemaining(end);
  if (rem === null || end === null || end === undefined) return null;
  const total = start !== null && start !== undefined ? Math.max(1, end - start) : Math.max(rem, 1);
  const pct = Math.max(0, Math.min(100, (rem / total) * 100));
  const frozen = view?.clock.frozen;
  const low = rem < 3000 && !frozen;
  const secs = Math.ceil(rem / 1000);
  return (
    <div className="row" style={{ flexWrap: 'nowrap', gap: 12 }} role="timer" aria-label={`${label ?? 'Time left'}: ${secs} seconds${frozen ? ' (paused)' : ''}`}>
      <div className={`timer ${low ? 'low' : ''} ${frozen ? 'frozen' : ''}`} style={{ flex: 1 }}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <span className={`clock ${low ? 'low' : ''}`} aria-hidden="true">
        {secs}
      </span>
    </div>
  );
}

export function formatPoints(s: string | undefined): string {
  if (!s) return '0';
  try {
    return Fraction.parse(s).toMixed();
  } catch {
    return s;
  }
}

export function ScoreStrip({ scores, players, highlight }: { scores: Record<string, string>; players: string[]; highlight?: string | null }) {
  const { view, memberId } = useGame();
  const names = memberNames(view);
  const sorted = [...players].sort((a, b) => Fraction.parse(scores[b] ?? '0').cmp(Fraction.parse(scores[a] ?? '0')));
  return (
    <div className="scorestrip" aria-label="Scores">
      {sorted.map((p) => (
        <div key={p} className={`scorechip ${p === memberId ? 'me' : ''}`} style={highlight === p ? { borderColor: 'var(--info)' } : undefined}>
          <Avatar id={p} name={names[p] ?? '?'} size={32} />
          <span className="small truncate" style={{ maxWidth: 110 }}>
            {names[p] ?? '—'}
          </span>
          <span className="num">{formatPoints(scores[p])}</span>
        </div>
      ))}
    </div>
  );
}

export function Banner({ tone = 'info', children, icon }: { tone?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode; icon?: string }) {
  return (
    <div className={`banner ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {icon && <span aria-hidden="true">{icon}</span>}
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

export function ErrorToast() {
  const { lastError } = useGame();
  const { t } = useI18n();
  useEffect(() => {
    if (!lastError) return;
    const timer = setTimeout(() => client.clearError(), 5000);
    return () => clearTimeout(timer);
  }, [lastError]);
  if (!lastError) return null;
  return (
    <div className="toast-host">
      <div className="toast banner bad" role="alert">
        <span style={{ flex: 1 }}>{lastError}</span>
        <button className="btn ghost sm" onClick={() => client.clearError()}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title} ref={ref} onClick={(e) => e.stopPropagation()}>
        <h2 className="display h3 card-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConnectionBadge() {
  const { status } = useGame();
  const { t } = useI18n();
  const map = { online: ['ok', t('online')], connecting: ['warn', t('reconnecting')], reconnecting: ['warn', t('reconnecting')], offline: ['bad', t('offline')], idle: ['', ''] } as const;
  const [tone, label] = map[status];
  if (!label) return null;
  return (
    <span className={`badge ${tone}`} role="status" aria-live="polite">
      <span className={`dot ${status === 'online' ? 'on' : 'off'}`} />
      {label}
    </span>
  );
}

export function Skeleton({ h = 20, w = '100%' }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} aria-hidden="true" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 28 }}>
      <div className="display h3">{title}</div>
      {children && <div className="muted" style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

export function Attribution({ text }: { text: string | null | undefined }) {
  const { t } = useI18n();
  if (!text) return null;
  return (
    <p className="small muted" style={{ margin: 0 }}>
      {t('source')}: {text}
    </p>
  );
}
