import { Paper, Stack, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { ProcessDefinition } from '@sm/shared';
import { ConnectionsPanel, ConstantsPanel, GeneralPanel, InputsPanel, OutputsPanel } from './DefinitionTabs';

type Def = ProcessDefinition;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper withBorder p="md">
      <Title order={5} mb="sm">
        {title}
      </Title>
      {children}
    </Paper>
  );
}

/** Process-level settings: general info, connection slots, inputs, constants and outputs. */
export function SettingsTab({ def, onChange }: { def: Def; onChange: (d: Def) => void }) {
  const { t } = useTranslation('editor');
  return (
    <Stack maw={960}>
      <Section title={t('settings.general')}>
        <GeneralPanel def={def} onChange={onChange} />
      </Section>
      <Section title={t('settings.connections', { count: def.connections?.length ?? 0 })}>
        <ConnectionsPanel def={def} onChange={onChange} />
      </Section>
      <Section title={t('settings.inputs', { count: def.inputs?.length ?? 0 })}>
        <InputsPanel def={def} onChange={onChange} />
      </Section>
      <Section title={t('settings.constants')}>
        <ConstantsPanel def={def} onChange={onChange} />
      </Section>
      <Section title={t('settings.outputs', { count: Object.keys(def.outputs ?? {}).length })}>
        <OutputsPanel def={def} onChange={onChange} />
      </Section>
    </Stack>
  );
}
