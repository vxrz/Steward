import { FileButton, Button, Group, JsonInput, NumberInput, Select, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { IconUpload } from '@tabler/icons-react';
import type { InputDef } from '@sm/shared';

export function defaultInputs(defs: InputDef[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    let v = d.default;
    if (d.type === 'list' && Array.isArray(v)) v = v.join('\n');
    if (d.type === 'json' && v !== undefined && typeof v !== 'string') v = JSON.stringify(v, null, 2);
    out[d.name] = v ?? (d.type === 'boolean' ? false : '');
  }
  return out;
}

export function InputsForm({
  defs,
  value,
  onChange,
}: {
  defs: InputDef[];
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  if (!defs.length) return <Text size="sm" c="dimmed">This process has no inputs.</Text>;
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <Stack gap="sm">
      {defs.map((d) => {
        const label = d.label ?? d.name;
        const common = { label, description: d.description, required: d.required };
        const v = value[d.name];
        switch (d.type) {
          case 'number':
            return <NumberInput key={d.name} {...common} value={(v as number | string) ?? ''} onChange={(x) => set(d.name, x)} />;
          case 'boolean':
            return <Switch key={d.name} {...common} checked={!!v} onChange={(e) => set(d.name, e.currentTarget.checked)} />;
          case 'select':
            return <Select key={d.name} {...common} data={d.options ?? []} value={(v as string) ?? null} onChange={(x) => set(d.name, x)} />;
          case 'list':
            return (
              <Textarea
                key={d.name} {...common}
                description={d.description ?? 'One value per line'}
                autosize
                minRows={2}
                maxRows={10}
                value={Array.isArray(v) ? v.join('\n') : ((v as string) ?? '')}
                onChange={(e) => set(d.name, e.currentTarget.value)}
              />
            );
          case 'table':
            return (
              <Stack gap={4} key={d.name}>
                <Textarea
                  label={label}
                  required={d.required}
                  description={`CSV with header row${d.columns?.length ? `: ${d.columns.join(', ')}` : ''} (comma, semicolon or tab separated)`}
                  autosize
                  minRows={3}
                  maxRows={14}
                  classNames={{ input: 'mono' }}
                  value={typeof v === 'string' ? v : v ? JSON.stringify(v) : ''}
                  onChange={(e) => set(d.name, e.currentTarget.value)}
                />
                <Group>
                  <FileButton accept=".csv,text/csv,text/plain" onChange={(f) => f && f.text().then((t) => set(d.name, t))}>
                    {(props) => (
                      <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />}>
                        Load CSV file
                      </Button>
                    )}
                  </FileButton>
                </Group>
              </Stack>
            );
          case 'json':
            return <JsonInput key={d.name} {...common} autosize minRows={3} formatOnBlur value={(v as string) ?? ''} onChange={(x) => set(d.name, x)} />;
          default:
            return <TextInput key={d.name} {...common} value={(v as string) ?? ''} onChange={(e) => set(d.name, e.currentTarget.value)} />;
        }
      })}
    </Stack>
  );
}
