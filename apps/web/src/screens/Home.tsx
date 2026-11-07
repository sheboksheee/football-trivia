import { MODE_KEYS, MODES } from '@ft/shared';
import { useI18n } from '../i18n.js';
import { modeCopy } from '../modeText.js';
import { client } from '../net/client.js';

export function Home({ go }: { go: (r: string) => void }) {
  const { t, locale } = useI18n();
  const saved = client.savedSession;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="card pitch hero">
        <div className="hero-copy">
          <div className="eyebrow">{t('heroEyebrow')}</div>
          <h1 className="display h1" style={{ margin: '12px 0' }}>
            {t('heroLine1')}
            <br />
            <span className="accent">{t('heroLine2')}</span>
          </h1>
          <p className="muted hero-tagline">{t('tagline')}</p>
        </div>
        <div className="stack hero-actions">
          {saved && (
            <button className="btn primary block" onClick={() => go(`#/room/${saved.code}`)}>
              {t('rejoin', { code: saved.code })}
            </button>
          )}
          <button className={`btn block ${saved ? '' : 'primary'}`} onClick={() => go('#/create')}>
            {t('playNow')}
          </button>
          <button className="btn block" onClick={() => go('#/join')}>
            {t('joinWithCode')}
          </button>
          <div className="row">
            <button className="btn ghost" onClick={() => go('#/how')}>
              {t('howToPlay')}
            </button>
            <button className="btn ghost" onClick={() => go('#/admin')}>
              {t('admin')}
            </button>
          </div>
        </div>
      </section>
      <section className="mode-strip" aria-label={t('howToPlay')}>
        {MODE_KEYS.map((k) => {
          const c = modeCopy(k, locale);
          return (
            <button
              key={k}
              className="mode-chip"
              onClick={() => go('#/how')}
              disabled={MODES[k].rulesStatus === 'BLOCKED'}
            >
              <span className="mode-num">{String(MODES[k].number).padStart(2, '0')}</span>
              <span className="mode-chip-name">{c.name}</span>
              <span className="small muted mode-chip-concept">{c.concept}</span>
            </button>
          );
        })}
      </section>
      <p className="small muted">{t('fictionalData')}</p>
    </div>
  );
}
