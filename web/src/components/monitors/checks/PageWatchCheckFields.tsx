import { checkPlatformKinds } from '@sm/shared';
import { PageWatchFields } from '../PageWatchFields';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** Watches of changedetection.io (#242). */
export function PageWatchCheckFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'page-watch'>) {
  return (
    <>
      <PlatformSelect
        value={c.platform}
        onChange={(v) => set({ platform: v })}
        platforms={platforms}
        kinds={checkPlatformKinds(c)}
        disabled={disabled}
        error={err('platform')}
      />
      <PageWatchFields check={c} set={set} platforms={platforms} disabled={disabled} err={err} />
    </>
  );
}
