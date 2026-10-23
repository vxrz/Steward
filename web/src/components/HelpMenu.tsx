import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Group, Kbd, List, Menu, Modal, Stack, Table, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconBook, IconExternalLink, IconHelp, IconInfoCircle, IconKeyboard, IconRocket, IconSparkles } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../../shared/src/brand';
import { useMe } from '../auth';

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** `g` followed by one of these keys opens the page (within {@link SEQUENCE_MS}). */
export const GO_KEYS = { d: '/', t: '/tasks', r: '/runs', m: '/monitors', p: '/processes' } as const;
type GoKey = keyof typeof GO_KEYS;
const GO_LABELS: Record<GoKey, 'dashboard' | 'tasks' | 'runs' | 'monitors' | 'processes'> = {
  d: 'dashboard',
  t: 'tasks',
  r: 'runs',
  m: 'monitors',
  p: 'processes',
};
const SEQUENCE_MS = 1500;

/** Typing, a dialog, a menu or the process canvas keep their own keys: no shortcut there. */
function ignoreTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return !!target.closest('[contenteditable="true"], .react-flow, .cm-editor, [role="dialog"], [role="menu"], [role="listbox"]');
}

/**
 * Global keyboard shortcuts: `?` opens the shortcut list, `g` then `d`/`t`/`r`/`m`/`p` opens a page.
 * Ctrl/⌘ K (search) belongs to the command palette.
 */
export function useGlobalShortcuts(onHelp: () => void) {
  const navigate = useNavigate();
  const pendingG = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || ignoreTarget(e.target)) return;
      if (e.key === '?') {
        e.preventDefault();
        pendingG.current = 0;
        onHelp();
        return;
      }
      const key = e.key.toLowerCase();
      if (pendingG.current && Date.now() - pendingG.current < SEQUENCE_MS && key in GO_KEYS) {
        e.preventDefault();
        pendingG.current = 0;
        navigate(GO_KEYS[key as GoKey]);
        return;
      }
      pendingG.current = key === 'g' && !e.shiftKey ? Date.now() : 0;
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, onHelp]);
}

function Keys({ keys }: { keys: string[] }) {
  const { t } = useTranslation('nav');
  return (
    <Group gap={4} wrap="nowrap">
      {keys.map((k, i) => (
        <Group key={i} gap={4} wrap="nowrap">
          {i > 0 && (
            <Text span size="xs" c="dimmed">
              {t('help.then')}
            </Text>
          )}
          <Kbd size="sm">{k}</Kbd>
        </Group>
      ))}
    </Group>
  );
}

/** The `?` dialog: every keyboard shortcut of the app. */
export function ShortcutsDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('nav');
  const rows: { keys: string[]; label: string }[] = [
    { keys: [isMac ? '⌘ K' : 'Ctrl K'], label: t('help.keys.search') },
    { keys: ['?'], label: t('help.keys.help') },
    ...(Object.keys(GO_KEYS) as GoKey[]).map((k) => ({ keys: ['g', k], label: t('help.keys.goTo', { page: t(`items.${GO_LABELS[k]}`) }) })),
    { keys: ['Esc'], label: t('help.keys.close') },
  ];
  return (
    <Modal opened={opened} onClose={onClose} title={t('help.shortcuts')} size="md">
      <Table fz="sm" verticalSpacing={6} aria-label={t('help.shortcuts')} data-testid="shortcut-list">
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.keys.join(' ')}>
              <Table.Td w={140}>
                <Keys keys={r.keys} />
              </Table.Td>
              <Table.Td>{r.label}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Text size="xs" c="dimmed" mt="sm">
        {t('help.shortcutsHint')}
      </Text>
    </Modal>
  );
}

/** Highlights of the coming release, curated in the locale files (not the raw CHANGELOG). */
const WHATS_NEW = ['lists', 'confirm', 'gitSync', 'tickets', 'dailySummary', 'credentials', 'compliance', 'mcp'] as const;

export function WhatsNewDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('nav');
  return (
    <Modal opened={opened} onClose={onClose} title={t('help.whatsNew')} size="lg">
      <Stack gap="sm" data-testid="whats-new">
        <Text size="sm" c="dimmed">
          {t('help.whatsNewIntro', { brand: BRAND.name })}
        </Text>
        <List
          spacing="sm"
          size="sm"
          icon={
            <ThemeIcon size={20} radius="xl" variant="light">
              <IconSparkles size={12} aria-hidden />
            </ThemeIcon>
          }
        >
          {WHATS_NEW.map((k) => (
            <List.Item key={k}>
              <Text span fw={600} size="sm">
                {t(`help.news.${k}.title`)}
              </Text>
              {' – '}
              {t(`help.news.${k}.text`)}
            </List.Item>
          ))}
        </List>
        <Text size="sm">
          <a href={`${BRAND.repoUrl}/blob/HEAD/CHANGELOG.md`} target="_blank" rel="noopener">
            {t('help.fullChangelog')}
          </a>
        </Text>
      </Stack>
    </Modal>
  );
}

const DOCS = [
  { key: 'guide', path: '#everyday-use' },
  { key: 'install', path: '/blob/HEAD/docs/INSTALL.md' },
  { key: 'mcp', path: '/blob/HEAD/docs/MCP.md' },
  { key: 'api', path: '/blob/HEAD/docs/API.md' },
  { key: 'gateway', path: '/blob/HEAD/docs/MONITORS.md#heartbeat-api-for-gateways' },
  { key: 'all', path: '/tree/HEAD/docs' },
] as const;

/**
 * Header menu "Help": what's new, the keyboard shortcuts, the getting-started checklist (administrators),
 * the documentation on GitHub and the About page. Also owns the global shortcuts.
 */
export function HelpMenu() {
  const { t } = useTranslation('nav');
  const navigate = useNavigate();
  const { isAdmin } = useMe();
  const [dialog, setDialog] = useState<'shortcuts' | 'news' | null>(null);
  const openShortcuts = useRef(() => setDialog('shortcuts')).current;
  useGlobalShortcuts(openShortcuts);
  return (
    <>
      <Menu position="bottom-end" width={260} withinPortal>
        <Menu.Target>
          <Tooltip label={t('help.label')}>
            <ActionIcon variant="subtle" aria-label={t('help.label')} data-testid="help-menu">
              <IconHelp size={18} />
            </ActionIcon>
          </Tooltip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item leftSection={<IconSparkles size={14} />} onClick={() => setDialog('news')}>
            {t('help.whatsNew')}
          </Menu.Item>
          <Menu.Item leftSection={<IconKeyboard size={14} />} rightSection={<Kbd size="xs">?</Kbd>} onClick={() => setDialog('shortcuts')}>
            {t('help.shortcuts')}
          </Menu.Item>
          {isAdmin && (
            <Menu.Item leftSection={<IconRocket size={14} />} onClick={() => navigate('/?checklist=1')}>
              {t('help.checklist')}
            </Menu.Item>
          )}
          <Menu.Divider />
          <Menu.Label>{t('help.docs')}</Menu.Label>
          {DOCS.map((d) => (
            <Menu.Item
              key={d.key}
              component="a"
              href={`${BRAND.repoUrl}${d.path}`}
              target="_blank"
              rel="noopener"
              leftSection={<IconBook size={14} />}
              rightSection={<IconExternalLink size={12} aria-hidden />}
            >
              {t(`help.doc.${d.key}`)}
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item leftSection={<IconInfoCircle size={14} />} onClick={() => navigate('/about')}>
            {t('userMenu.about', { brand: BRAND.name })}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <ShortcutsDialog opened={dialog === 'shortcuts'} onClose={() => setDialog(null)} />
      <WhatsNewDialog opened={dialog === 'news'} onClose={() => setDialog(null)} />
    </>
  );
}
