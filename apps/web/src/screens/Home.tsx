import { useI18n } from '../i18n.js';
import { client } from '../net/client.js';

export function Home({ go }: { go: (r: string) => void }) {
  const { t } = useI18n();
  const saved = client.savedSession;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card pitch" style={{ padding: '36px 20px' }}>
        <div className="eyebrow">Matchday · 2–6 players · unlimited spectators</div>
        <h1 className="display h1" style={{ margin: '12px 0' }}>
          Football<br />
          <span className="accent">Trivia</span>
        </h1>
        <p className="muted" style={{ maxWidth: 520, fontSize: 18 }}>{t('tagline')}</p>
        <div className="stack" style={{ maxWidth: 420, marginTop: 20 }}>
          {saved && (
            <button className="btn primary block" onClick={() => go(`#/room/${saved.code}`)}>
              Rejoin room {saved.code}
            </button>
          )}
          <button className={`btn block ${saved ? '' : 'primary'}`} onClick={() => go('#/create')}>
            {t('playNow')}
          </button>
          <button className="btn block" onClick={() => go('#/join')}>
            {t('joinWithCode')}
          </button>
          <div className="row">
            <button className="btn ghost" onClick={() => go('#/how')}>{t('howToPlay')}</button>
            <button className="btn ghost" onClick={() => go('#/admin')}>{t('admin')}</button>
          </div>
        </div>
      </section>
      <p className="small muted">{t('fictionalData')}</p>
    </div>
  );
}
