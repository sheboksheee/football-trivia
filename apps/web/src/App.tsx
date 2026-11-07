import { useCallback, useEffect, useMemo, useState } from 'react';
import { DICTS, I18nContext, type Locale } from './i18n.js';
import { ConnectionBadge, ErrorToast } from './ui/common.js';
import { Home } from './screens/Home.js';
import { Entry } from './screens/Entry.js';
import { Room } from './screens/Room.js';
import { HowToPlay } from './screens/HowToPlay.js';
import { Admin } from './screens/Admin.js';

const LOCALE_KEY = 'ft.locale';
function initialLocale(): Locale {
  try {
    const s = localStorage.getItem(LOCALE_KEY);
    if (s === 'ar' || s === 'en') return s;
  } catch {
    /* ignore */
  }
  return navigator.language.startsWith('ar') ? 'ar' : 'en';
}

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((h: string) => {
    location.hash = h;
  }, []);
  return [hash, go] as const;
}

export function App() {
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [hash, go] = useHash();
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      /* ignore */
    }
  }, [locale]);
  const i18n = useMemo(() => ({ locale, setLocale, t: (k: keyof (typeof DICTS)['en']) => DICTS[locale][k] }), [locale]);
  const parts = hash.replace(/^#\/?/, '').split('/');
  let page;
  switch (parts[0]) {
    case 'create':
      page = <Entry mode="create" go={go} />;
      break;
    case 'join':
      page = <Entry mode="join" go={go} initialCode={parts[1]?.toUpperCase()} />;
      break;
    case 'room':
      page = <Room key={parts[1]} code={(parts[1] ?? '').toUpperCase()} go={go} />;
      break;
    case 'how':
      page = <HowToPlay />;
      break;
    case 'admin':
      page = <Admin />;
      break;
    default:
      page = <Home go={go} />;
  }
  return (
    <I18nContext.Provider value={i18n}>
      <a href="#main" className="sr-only">Skip to content</a>
      <div className="shell">
        <header className="topbar">
          <button className="brand" onClick={() => go('#/')} aria-label="Football Trivia home">
            <span className="brand-mark" aria-hidden="true">FT</span>
            <span>{i18n.t('appName')}</span>
          </button>
          <span className="spacer" />
          <ConnectionBadge />
          <button className="btn ghost sm" onClick={() => setLocale(locale === 'en' ? 'ar' : 'en')} lang={locale === 'en' ? 'ar' : 'en'}>
            {i18n.t('language')}
          </button>
        </header>
        <main id="main">{page}</main>
      </div>
      <ErrorToast />
    </I18nContext.Provider>
  );
}
