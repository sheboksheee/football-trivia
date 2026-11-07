import { useEffect, useState } from 'react';
import { useI18n } from '../i18n.js';
import { client } from '../net/client.js';
import { useGame } from '../net/hooks.js';
import { Banner, Skeleton } from '../ui/common.js';
import { Lobby } from './Lobby.js';
import { Game } from './Game.js';

/** Resolves a room route: resume the stored session, or send the visitor to join. */
export function Room({ code, go }: { code: string; go: (r: string) => void }) {
  const { t } = useI18n();
  const snap = useGame();
  const bound = snap.roomCode === code && snap.memberId !== null;
  const [state, setState] = useState<'loading' | 'needJoin' | 'error' | 'ready'>(bound ? 'ready' : 'loading');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Already bound on this socket (just created/joined): the state message is on its way.
    if (bound) return setState('ready');
    let alive = true;
    (async () => {
      try {
        await client.connect();
        const ack = await client.resume(code);
        if (!alive) return;
        if (!ack) return setState('needJoin');
        if (!ack.ok) {
          setErr(ack.error?.message ?? null);
          return setState('needJoin');
        }
        setState('ready');
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per room code
  }, [code]);

  if (snap.kicked) {
    return (
      <div className="stack" style={{ maxWidth: 480, margin: '0 auto' }}>
        <Banner tone="warn">{snap.kicked}</Banner>
        <button
          className="btn"
          onClick={() => {
            client.clearKick();
            go('#/');
          }}
        >
          {t('newGame')}
        </button>
      </div>
    );
  }
  if (state === 'needJoin') {
    return (
      <div className="stack" style={{ maxWidth: 480, margin: '0 auto' }}>
        {err && <Banner tone="warn">{err}</Banner>}
        <Banner>You’re not in room {code} on this device yet.</Banner>
        <button className="btn primary" onClick={() => go(`#/join/${code}`)}>
          {t('join')} {code}
        </button>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="stack" style={{ maxWidth: 480, margin: '0 auto' }}>
        <Banner tone="bad">Cannot reach the game server.</Banner>
        <button className="btn" onClick={() => location.reload()}>
          {t('tryAgain')}
        </button>
      </div>
    );
  }
  const view = snap.view;
  if (!view) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading room">
        <Skeleton h={120} />
        <Skeleton h={60} />
        <Skeleton h={60} />
      </div>
    );
  }
  const inLobby =
    view.room.status === 'LOBBY' ||
    view.room.status === 'READY_CHECK' ||
    (view.room.status === 'SUSPENDED' && !view.matchNight);
  return (
    <div className="stack">
      {snap.status !== 'online' && (
        <Banner tone="warn">
          {t('reconnecting')} Your seat is held for 30 seconds; answer timers do not pause for disconnects.
        </Banner>
      )}
      {inLobby ? <Lobby view={view} /> : <Game view={view} />}
      {view.room.status !== 'COMPLETED' && (
        <div className="row">
          <span className="spacer" />
          <button
            className="btn ghost sm"
            onClick={async () => {
              if (
                confirm(
                  view.matchNight
                    ? 'Leave during play? You forfeit future modes but keep completed-mode points.'
                    : 'Leave this room?',
                )
              ) {
                await client.leave();
                go('#/');
              }
            }}
          >
            {t('leave')}
          </button>
        </div>
      )}
    </div>
  );
}
