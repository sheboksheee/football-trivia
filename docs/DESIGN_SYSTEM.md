# Premium Football Gaming Design System

Design direction: editorial sports broadcast meets modern gaming UI. Distinctive, polished, fast, readable and not a generic dashboard.

- Colors: near-black `#0B1016`, elevated slate `#151E28`, pitch green `#B7FF43`, soft white `#F4F7FA`, muted text `#9EADBC`. Use green for actions, not every surface.
- Typography: bold condensed display headlines paired with legible sans body. Support Arabic RTL and English LTR with appropriate fonts, avoid shipping bundled font files without rights.
- Visual identity: subtle pitch geometry, restrained stadium lighting, player silhouettes only when licensed, crisp statistics and matchday scoreboards.
- Layout: mobile-first 360px up, desktop widescreen room display; safe areas, keyboard and landscape states.
- Motion: 120–250ms responsive transitions, reduced-motion support; timers and buzzer priority over decoration.
- Core screens: landing, create/join room, lobby, playlist, ready check, question stage, player answer, judge console, appeal review, leaderboard, match night champion, admin content studio.
- Quality gates: WCAG AA contrast for critical text, no invisible interactive affordances, no fake results, skeleton/empty/error states, 44px tap targets, RTL and responsive screenshots.
