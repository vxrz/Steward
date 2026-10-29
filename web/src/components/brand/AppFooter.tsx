import { Anchor, Group, Text } from '@mantine/core';
import { IconBrandGithub } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { BRAND } from '../../../../shared/src/brand';
import { WEB_BUILD } from '../../buildInfo';
import { FrankenRechen } from './FrankenRechen';

const Dot = () => (
  <Text span c="dimmed" aria-hidden>
    ·
  </Text>
);

/**
 * Centred footer with the Steward product identity (also with a custom app name and logo). Shown only where it is
 * useful, so it does not repeat on every page:
 * - `full` (About page): origin, region, author, copyright, licence, source link, version and the About link
 * - `compact` (sign-in page): origin, licence, source link and version (plus About for signed-in users)
 * One line on wide screens where it fits, smaller and wrapped on phones.
 */
export function AppFooter({ signedIn = false, variant = 'compact' }: { signedIn?: boolean; variant?: 'full' | 'compact' }) {
  const { t } = useTranslation();
  return (
    <Text component="footer" c="dimmed" ta="center" px="xs" className="app-footer">
      <Group gap="4px 6px" justify="center" wrap="wrap" component="span">
        <span>
          <Trans
            i18nKey="footer.madeWith"
            components={{
              heart: (
                <span role="img" aria-label={t('footer.love')}>
                  ❤️
                </span>
              ),
            }}
          />
        </span>
        {variant === 'full' && (
          <>
            <Dot />
            <Group gap={5} wrap="nowrap" component="span">
              Metropolregion Nürnberg <FrankenRechen height={12} />
            </Group>
            <Dot />
            <span>
              <Trans
                i18nKey="footer.builtBy"
                values={{ author: BRAND.author }}
                components={{ author: <Anchor href={BRAND.authorUrl} target="_blank" rel="noopener" inherit c="dimmed" underline="always" /> }}
              />
            </span>
            <Dot />
            <span>
              © {BRAND.copyrightYear} {BRAND.author}
            </span>
          </>
        )}
        <Dot />
        <Anchor href={`${BRAND.repoUrl}/blob/HEAD/LICENSE`} target="_blank" rel="noopener" inherit c="dimmed">
          {t('footer.openSource', { license: BRAND.license })}
        </Anchor>
        <Dot />
        <Anchor href={BRAND.repoUrl} target="_blank" rel="noopener" inherit c="dimmed" aria-label={t('footer.onGithub', { brand: BRAND.name })}>
          <Group gap={4} component="span" wrap="nowrap">
            <IconBrandGithub size={12} aria-hidden />
            GitHub
          </Group>
        </Anchor>
        <Dot />
        <span>{t('footer.version', { brand: BRAND.name, version: WEB_BUILD.version })}</span>
        {signedIn && (
          <>
            <Dot />
            <Anchor component={Link} to="/about" inherit c="dimmed">
              {t('footer.about', { brand: BRAND.name })}
            </Anchor>
          </>
        )}
      </Group>
    </Text>
  );
}
