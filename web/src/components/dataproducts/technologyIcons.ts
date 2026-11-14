import {
  IconAntenna,
  IconApi,
  IconArrowsExchange,
  IconBuildingFactory2,
  IconCloud,
  IconDatabase,
  IconFile,
  IconRoute,
  IconShape,
  IconTable,
  IconTimeline,
  type Icon,
} from '@tabler/icons-react';
import type { DataTechnologyIcon } from '@sm/shared';

/** The icons of the technology list (DATA_TECHNOLOGY_ICONS, ADR 0037) in the web app's icon set: forms, pages and pictures. */
export const TECHNOLOGY_ICON: Record<DataTechnologyIcon, Icon> = {
  database: IconDatabase,
  table: IconTable,
  topic: IconTimeline,
  file: IconFile,
  api: IconApi,
  bridge: IconArrowsExchange,
  flow: IconRoute,
  edge: IconBuildingFactory2,
  cloud: IconCloud,
  sensor: IconAntenna,
  other: IconShape,
};
