import { Paper, SegmentedControl, Stack, Switch, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { REPORT_LANGS, type ProcessDefinition, type ReportLang } from '@sm/shared';
import { reportLangName } from '../reports/RunReports';
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
      <Section title={t('settings.report.title')}>
        <ReportPanel def={def} onChange={onChange} />
      </Section>
    </Stack>
  );
}

/** process.report: archive the run report automatically when a run finishes. */
function ReportPanel({ def, onChange }: { def: Def; onChange: (d: Def) => void }) {
  const { t } = useTranslation('editor');
  const auto = !!def.report?.auto;
  const lang = def.report?.lang ?? 'en';
  const set = (next: { auto: boolean; lang: ReportLang }) => {
    const { report: _r, ...rest } = def;
    onChange(next.auto || next.lang !== 'en' ? { ...rest, report: { ...(next.auto ? { auto: true } : {}), ...(next.lang !== 'en' ? { lang: next.lang } : {}) } } : (rest as Def));
  };
  return (
    <Stack gap="sm">
      <Switch
        label={t('settings.report.auto')}
        description={t('settings.report.autoHint')}
        checked={auto}
        onChange={(e) => set({ auto: e.currentTarget.checked, lang })}
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          {t('settings.report.language')}
        </Text>
        <SegmentedControl
          w={220}
          value={lang}
          disabled={!auto}
          onChange={(v) => set({ auto, lang: v as ReportLang })}
          data={REPORT_LANGS.map((code) => ({ value: code, label: reportLangName(code) }))}
        />
      </Stack>
    </Stack>
  );
}
