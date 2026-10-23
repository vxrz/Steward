import { useTranslation } from 'react-i18next';

/**
 * The Franconian rake ("Fränkischer Rechen"): in red, three silver points.
 * The regional symbol of Franconia – not the official coat of arms of the
 * Bezirk Mittelfranken, whose use by third parties needs permission.
 */
export function FrankenRechen({ height = 14 }: { height?: number }) {
  const { t } = useTranslation();
  return (
    <svg
      viewBox="0 0 100 120"
      height={height}
      width={(height * 100) / 120}
      role="img"
      aria-label={t('footer.rake')}
      style={{ display: 'inline-block', verticalAlign: '-0.15em', flexShrink: 0 }}
    >
      <title>{t('footer.rakeTitle')}</title>
      <defs>
        <clipPath id="sm-franken-shield">
          <path d="M4 4H96V58C96 90 74 108 50 116C26 108 4 90 4 58Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#sm-franken-shield)">
        <rect width="100" height="120" fill="#d52b1e" />
        {/* three silver points rising from below (four red teeth) */}
        <path d="M0 30L12.5 70L25 30L37.5 70L50 30L62.5 70L75 30L87.5 70L100 30V120H0Z" fill="#fff" />
      </g>
      <path d="M4 4H96V58C96 90 74 108 50 116C26 108 4 90 4 58Z" fill="none" stroke="currentColor" strokeOpacity=".35" strokeWidth="4" />
    </svg>
  );
}
