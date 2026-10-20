# Dashboard fonts

Served by the daemon at `/assets/fonts/<file>` (see `src/ui/assets.ts`) so
the dashboard loads nothing from a third-party CDN.

| File | Family | Licence |
|---|---|---|
| `fraunces-latin.woff2` | Fraunces (variable: opsz, wght) | `OFL-fraunces.txt` |
| `space-grotesk-latin.woff2` | Space Grotesk (variable: wght) | `OFL-spacegrotesk.txt` |
| `jetbrains-mono-latin.woff2` | JetBrains Mono (variable: wght) | `OFL-jetbrainsmono.txt` |

All three are the Latin subset (U+0000-00FF plus common punctuation) of the
upstream variable fonts, as distributed by Google Fonts, under the SIL Open
Font License 1.1. Characters outside that range fall back to the system font
named next to each family in `styles.ts`.
