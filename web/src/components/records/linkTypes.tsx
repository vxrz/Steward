import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  IconActivity,
  IconBell,
  IconBook,
  IconBrandGit,
  IconBuildingStore,
  IconCalendar,
  IconChartLine,
  IconCloud,
  IconCode,
  IconDatabase,
  IconFileText,
  IconFolder,
  IconKey,
  IconLifebuoy,
  IconLink,
  IconMessage,
  IconServer,
  IconShield,
  IconTicket,
  IconTool,
  IconUsers,
  IconWorld,
  type Icon,
} from '@tabler/icons-react';
import { BUILTIN_LINK_TYPES, DEFAULT_LINK_TYPE, type LinkType, type LinkTypeIcon } from '@sm/shared';
import { get } from '../../api';

/** The fixed set of icons a link type can have (shared/src/records.ts LINK_TYPE_ICONS). */
export const LINK_TYPE_ICON_COMPONENTS: Record<LinkTypeIcon, Icon> = {
  book: IconBook,
  git: IconBrandGit,
  activity: IconActivity,
  building: IconBuildingStore,
  file: IconFileText,
  ticket: IconTicket,
  link: IconLink,
  server: IconServer,
  database: IconDatabase,
  cloud: IconCloud,
  shield: IconShield,
  chart: IconChartLine,
  bell: IconBell,
  tool: IconTool,
  key: IconKey,
  users: IconUsers,
  message: IconMessage,
  calendar: IconCalendar,
  folder: IconFolder,
  world: IconWorld,
  code: IconCode,
  lifebuoy: IconLifebuoy,
};

export function LinkTypeIconView({ icon, size = 16 }: { icon: LinkTypeIcon | string; size?: number }) {
  const C = LINK_TYPE_ICON_COMPONENTS[icon as LinkTypeIcon] ?? IconLink;
  return <C size={size} aria-hidden />;
}

/** All link types (built-in and the administrators' own, archived ones too). */
export const useLinkTypes = () => useQuery({ queryKey: ['link-types'], queryFn: () => get<LinkType[]>('/link-types'), staleTime: 60_000 });

const FALLBACK: LinkType = {
  ...BUILTIN_LINK_TYPES.find((t) => t.key === DEFAULT_LINK_TYPE)!,
  builtin: true,
  archived: false,
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
};

/** Name of a link type: built-in ones in the UI language. */
export function useLinkTypeName() {
  const { t } = useTranslation('records');
  return (lt: Pick<LinkType, 'key' | 'name' | 'builtin'>): string =>
    lt.builtin ? t(`links.types.${lt.key as 'runbook'}`, { defaultValue: lt.name }) : lt.name;
}

/** The type of a link: its type, or "Other" for links without one (or with a type that no longer exists). */
export function linkTypeOf(types: LinkType[] | undefined, key: string | null): LinkType {
  return (key && types?.find((t) => t.key === key)) || types?.find((t) => t.key === DEFAULT_LINK_TYPE) || FALLBACK;
}
