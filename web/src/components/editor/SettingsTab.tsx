import { Paper, Stack, Title } from '@mantine/core';
import type { ProcessDefinition } from '@sm/shared';
import { ConnectionsPanel, ConstantsPanel, GeneralPanel, InputsPanel } from './DefinitionTabs';

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

/** Process-level settings: general info, connection slots, inputs and constants. */
export function SettingsTab({ def, onChange }: { def: Def; onChange: (d: Def) => void }) {
  return (
    <Stack maw={960}>
      <Section title="General">
        <GeneralPanel def={def} onChange={onChange} />
      </Section>
      <Section title={`Connections (${def.connections?.length ?? 0})`}>
        <ConnectionsPanel def={def} onChange={onChange} />
      </Section>
      <Section title={`Inputs (${def.inputs?.length ?? 0})`}>
        <InputsPanel def={def} onChange={onChange} />
      </Section>
      <Section title="Constants">
        <ConstantsPanel def={def} onChange={onChange} />
      </Section>
    </Stack>
  );
}
