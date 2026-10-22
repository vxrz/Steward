import { Anchor, Group, Text } from '@mantine/core';
import { IconBrandGithub } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { BRAND } from '../../../../shared/src/brand';
import { FrankenRechen } from './FrankenRechen';

const Dot = () => (
  <Text span c="dimmed" aria-hidden>
    ·
  </Text>
);

/** Small centred footer: origin, author, copyright, licence and source link. */
export function AppFooter() {
  const { t } = useTranslation();
  return (
    <Text component="footer" size="xs" c="dimmed" ta="center" py="md" px="xs" style={{ lineHeight: 1.7 }}>
      <Group gap={6} justify="center" wrap="wrap" component="span">
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
        <Dot />
        <Group gap={5} wrap="nowrap" component="span">
          Metropolregion Mittelfranken <FrankenRechen />
        </Group>
        <Dot />
        <span>
          <Trans
            i18nKey="footer.builtBy"
            values={{ author: BRAND.author }}
            components={{ author: <Anchor href={BRAND.authorUrl} target="_blank" rel="noopener" inherit c="dimmed" underline="always" /> }}
          />
        </span>
      </Group>
      <Group gap={6} justify="center" wrap="wrap" component="span">
        <span>
          © {BRAND.copyrightYear} {BRAND.author}
        </span>
        <Dot />
        <Anchor href={`${BRAND.repoUrl}/blob/HEAD/LICENSE`} target="_blank" rel="noopener" inherit c="dimmed">
          {t('footer.openSource', { license: BRAND.license })}
        </Anchor>
        <Dot />
        <Anchor href={BRAND.repoUrl} target="_blank" rel="noopener" inherit c="dimmed" aria-label={t('footer.onGithub', { brand: BRAND.name })}>
          <Group gap={4} component="span" wrap="nowrap">
            <IconBrandGithub size={13} aria-hidden />
            GitHub
          </Group>
        </Anchor>
      </Group>
    </Text>
  );
}
