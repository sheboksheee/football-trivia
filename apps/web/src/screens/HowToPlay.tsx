import { MODES, MODE_KEYS } from '@ft/shared';
import { useI18n } from '../i18n.js';
import { modeCopy } from '../modeText.js';

export function HowToPlay() {
  const { t, locale } = useI18n();
  return (
    <div className="stack">
      <h1 className="display h2">{t('how_title')}</h1>
      <section className="card stack">
        <h2 className="display h3">{t('how_matchNight')}</h2>
        <p style={{ margin: 0 }}>{t('how_p1')}</p>
        <p style={{ margin: 0 }}>{t('how_p2')}</p>
        <p style={{ margin: 0 }} className="muted">
          {t('how_p3')}
        </p>
      </section>
      <div className="modes">
        {MODE_KEYS.map((k) => {
          const m = MODES[k];
          const c = modeCopy(k, locale);
          return (
            <article key={k} className="card stack" style={{ gap: 8 }}>
              <div className="row">
                <span className="eyebrow">{String(m.number).padStart(2, '0')}</span>
                <span className="spacer" />
                <span
                  className={`badge ${m.rulesStatus === 'APPROVED' ? 'ok' : m.rulesStatus === 'PROVISIONAL' ? 'warn' : 'bad'}`}
                >
                  {m.rulesStatus === 'APPROVED'
                    ? t('rulesApproved')
                    : m.rulesStatus === 'PROVISIONAL'
                      ? t('rulesProvisional')
                      : t('rulesBlocked')}
                </span>
              </div>
              <h2 className="display h3" style={{ margin: 0 }}>
                {c.name}{' '}
                <span
                  className="muted small"
                  lang={locale === 'ar' ? 'en' : 'ar'}
                  dir={locale === 'ar' ? 'ltr' : 'rtl'}
                >
                  {locale === 'ar' ? m.name.en : modeCopy(k, 'ar').name}
                </span>
              </h2>
              <p className="small" style={{ margin: 0 }}>
                {c.concept}
              </p>
              <p className="small muted" style={{ margin: 0 }}>
                {c.rules}
              </p>
              <p className="small muted" style={{ margin: 0 }}>
                {t('how_players', { min: m.minPlayers, max: m.maxPlayers })}
                {m.judge === 'required'
                  ? t('how_needsJudge')
                  : m.judge === 'optional'
                    ? t('how_judgeOptional')
                    : ''}
              </p>
              {c.proposed.length > 0 && (
                <details>
                  <summary className="small">{t('how_proposed')}</summary>
                  <ul className="small muted">
                    {c.proposed.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </details>
              )}
              {c.blockers.length > 0 && (
                <ul className="small" style={{ color: 'var(--danger)' }}>
                  {c.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
