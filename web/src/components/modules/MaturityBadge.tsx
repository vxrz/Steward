import { Badge, Tooltip, VisuallyHidden } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Maturity, VerifiedAgainst } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod into the first download.
import { kindMaturity } from '../../../../shared/src/modules';
import { BRAND } from '../../../../shared/src/brand';

const COLOR: Record<Maturity, string> = { stable: 'green', beta: 'blue', preview: 'orange' };

/**
 * How far an area or a connector is (P1): stable, beta or preview, with what it was checked against in the tooltip.
 * Stable needs no badge where space is short (`hideStable`).
 */
export function MaturityBadge({
  maturity,
  verified,
  hideStable,
  inert,
}: {
  maturity: Maturity;
  verified?: VerifiedAgainst;
  hideStable?: boolean;
  /** Inside a button or link: no tooltip and no own tab stop (the explanation is its title) */
  inert?: boolean;
}) {
  const { t } = useTranslation('modules');
  if (hideStable && maturity === 'stable') return null;
  const explain = [t(`maturity.${maturity}.text`), verified ? t(`verified.${verified}`, { brand: BRAND.name }) : null].filter(Boolean).join(' ');
  if (inert)
    return (
      <Badge size="xs" variant="light" color={COLOR[maturity]} title={explain} data-testid="maturity-badge" data-maturity={maturity} style={{ flexShrink: 0 }}>
        {t(`maturity.${maturity}.name`)}
      </Badge>
    );
  return (
    <Tooltip label={explain} multiline w={280} withArrow events={{ hover: true, focus: true, touch: true }}>
      <Badge
        size="xs"
        variant="light"
        color={COLOR[maturity]}
        tabIndex={0}
        data-testid="maturity-badge"
        data-maturity={maturity}
        style={{ cursor: 'help', flexShrink: 0 }}
      >
        {t(`maturity.${maturity}.name`)}
        <VisuallyHidden>{` – ${explain}`}</VisuallyHidden>
      </Badge>
    </Tooltip>
  );
}

/** The maturity of a platform kind (connector), if it has one (own connector types have none). */
export function KindMaturityBadge({ kind, hideStable, inert }: { kind: string | null | undefined; hideStable?: boolean; inert?: boolean }) {
  const m = kindMaturity(kind);
  return m ? <MaturityBadge maturity={m.maturity} verified={m.verified} hideStable={hideStable} inert={inert} /> : null;
}
