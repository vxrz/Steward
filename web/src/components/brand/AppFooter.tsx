import { Anchor, Group, Text } from '@mantine/core';
import { IconBrandGithub } from '@tabler/icons-react';
import { BRAND } from '../../../../shared/src/brand';
import { FrankenRechen } from './FrankenRechen';

const Dot = () => (
  <Text span c="dimmed" aria-hidden>
    ·
  </Text>
);

/** Small centred footer: origin, author, copyright, licence and source link. */
export function AppFooter() {
  return (
    <Text component="footer" size="xs" c="dimmed" ta="center" py="md" px="xs" style={{ lineHeight: 1.7 }}>
      <Group gap={6} justify="center" wrap="wrap" component="span">
        <span>
          Made with{' '}
          <span role="img" aria-label="love">
            ❤️
          </span>{' '}
          in Erlangen, Germany
        </span>
        <Dot />
        <Group gap={5} wrap="nowrap" component="span">
          Metropolregion Mittelfranken <FrankenRechen />
        </Group>
        <Dot />
        <span>
          Designed and developed by{' '}
          <Anchor href={BRAND.authorUrl} target="_blank" rel="noopener" inherit c="dimmed" underline="always">
            {BRAND.author}
          </Anchor>{' '}
          with AI
        </span>
      </Group>
      <Group gap={6} justify="center" wrap="wrap" component="span">
        <span>
          © {BRAND.copyrightYear} {BRAND.author}
        </span>
        <Dot />
        <Anchor href={`${BRAND.repoUrl}/blob/HEAD/LICENSE`} target="_blank" rel="noopener" inherit c="dimmed">
          Open source ({BRAND.license})
        </Anchor>
        <Dot />
        <Anchor href={BRAND.repoUrl} target="_blank" rel="noopener" inherit c="dimmed" aria-label={`${BRAND.name} on GitHub`}>
          <Group gap={4} component="span" wrap="nowrap">
            <IconBrandGithub size={13} aria-hidden />
            GitHub
          </Group>
        </Anchor>
      </Group>
    </Text>
  );
}
