import { isValidElement, useRef, type ReactNode } from 'react';
import { ActionIcon, Group, Menu, Tooltip } from '@mantine/core';
import { Link, useLocation } from 'react-router-dom';
import { IconCopy, IconDots, type Icon } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PageHeader, type Crumb } from '../common';
import { SaveBar, SaveBarProvider } from '../settings/SaveBar';
import { useRememberRecent, type RecentKind } from './recent';

/** One entry of a detail page's actions menu. */
export interface DetailMenuItem {
  label: ReactNode;
  icon?: Icon;
  onClick?: () => void;
  /** A link instead of an action */
  to?: string;
  color?: string;
  disabled?: boolean;
  testId?: string;
}

const isItem = (x: unknown): x is DetailMenuItem => !!x && typeof x === 'object' && !isValidElement(x) && 'label' in x;

function MenuEntry({ item, fallbackIcon, beforeClick }: { item: DetailMenuItem; fallbackIcon?: Icon; beforeClick?: () => void }) {
  const I = item.icon ?? fallbackIcon;
  const common = { leftSection: I ? <I size={14} /> : undefined, color: item.color, disabled: item.disabled, 'data-testid': item.testId };
  return item.to ? (
    <Menu.Item component={Link} to={item.to} {...common}>
      {item.label}
    </Menu.Item>
  ) : (
    <Menu.Item
      onClick={() => {
        beforeClick?.();
        item.onClick?.();
      }}
      {...common}
    >
      {item.label}
    </Menu.Item>
  );
}

/**
 * The "More actions" menu (⋯) of a detail page header: the actions that are not used every day. It shows only
 * when it has something.
 *
 * `duplicate` is the slot for "Duplicate" (first in the menu): pass `{ label, onClick }` – the copy icon is
 * added – or a ready `<Menu.Item>`. `items` are further actions, `extra` raw `<Menu.Item>`s at the end.
 */
export function DetailActions({
  duplicate,
  items = [],
  extra,
  label,
}: {
  duplicate?: DetailMenuItem | ReactNode;
  items?: DetailMenuItem[];
  extra?: ReactNode;
  label?: string;
}) {
  const { t } = useTranslation();
  const shown = items.filter(Boolean);
  // a dialog an entry opens remembers what had the focus: the menu's button, not the entry that is gone once the menu
  // closes – so the focus comes back to the button when the dialog closes
  const target = useRef<HTMLButtonElement>(null);
  const focusTarget = () => target.current?.focus({ preventScroll: true });
  if (!duplicate && !shown.length && !extra) return null;
  const name = label ?? t('detailPage.moreActions');
  return (
    <Menu position="bottom-end" withinPortal shadow="md">
      <Menu.Target>
        <Tooltip label={name} withArrow>
          <ActionIcon ref={target} variant="default" size="input-xs" aria-label={name} data-testid="detail-actions">
            <IconDots size={16} />
          </ActionIcon>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        {duplicate &&
          (isItem(duplicate) ? <MenuEntry item={{ testId: 'detail-duplicate', ...duplicate }} fallbackIcon={IconCopy} beforeClick={focusTarget} /> : duplicate)}
        {shown.map((item, i) => (
          <MenuEntry key={i} item={item} beforeClick={focusTarget} />
        ))}
        {extra}
      </Menu.Dropdown>
    </Menu>
  );
}

export interface DetailHeaderProps {
  /** The way back (breadcrumb), as with PageHeader */
  back?: Crumb | Crumb[];
  title: ReactNode;
  /** Badges beside the title: status, criticality, archived … */
  status?: ReactNode;
  description?: ReactNode;
  /** The everyday actions as buttons (Edit, Run …) */
  actions?: ReactNode;
  /** The actions menu: see {@link DetailActions} */
  menu?: { duplicate?: DetailMenuItem | ReactNode; items?: DetailMenuItem[]; extra?: ReactNode };
  /** Tabs below the header (LinkTabs) */
  tabs?: ReactNode;
  /** Remember the page for the command palette's "Recent" (name and kind; the address defaults to the current one) */
  recent?: { label: string; kind: RecentKind; to?: string };
}

/**
 * The header of every detail page (v0.4.0): breadcrumb, title with its status, the everyday actions as buttons,
 * the rest in the actions menu, and the page's tabs.
 */
export function DetailHeader({ back, title, status, description, actions, menu, tabs, recent }: DetailHeaderProps) {
  const { pathname } = useLocation();
  useRememberRecent(recent ? { to: recent.to ?? pathname, label: recent.label, kind: recent.kind } : null);
  const more = menu ? <DetailActions {...menu} /> : null;
  return (
    <>
      <PageHeader
        back={back}
        title={
          status ? (
            <Group gap="sm" wrap="wrap" component="span">
              <span>{title}</span>
              {status}
            </Group>
          ) : (
            title
          )
        }
        description={description}
        actions={
          actions || more ? (
            <>
              {actions}
              {more}
            </>
          ) : undefined
        }
      />
      {tabs}
    </>
  );
}

/**
 * A detail page: the header, the content and – for forms on the page that register with `useSaveSection` – the
 * sticky bar that saves all unsaved changes at once.
 */
export function DetailPage({ children, ...header }: DetailHeaderProps & { children: ReactNode }) {
  return (
    <SaveBarProvider>
      <DetailHeader {...header} />
      {children}
      <SaveBar />
    </SaveBarProvider>
  );
}
