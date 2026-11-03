import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, ScrollArea, Stack, Table, Text, TextInput } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { IconTemplate } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DuplicateResult, MonitorDetail, MonitorTemplateParamChoice } from '@sm/shared';
import i18n from '../../i18n';
import { ApiError, notifyError, notifyOk, post } from '../../api';
import { errorText } from '../../i18n/errors';

/** Fields that never become parameters: what identifies a card, how it is drawn, and its texts. */
const NOT_PARAMETERS = new Set(['id', 'type', 'name', 'description', 'x', 'y', 'enabled', 'critical']);
/** Fields that differ from one instance to the next: chosen from the start. */
const USUAL = /^(host|url|assetId|endpointKey|.*[kK]ey|platform|namespace|topic|database|repository|project|service)$/;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

interface Row {
  checkId: string;
  checkName: string;
  field: string;
  value: string;
}

/**
 * Save as template (0.4.0): the saved monitor becomes a monitor template (POST /monitors/:id/duplicate with `template`).
 * The fields chosen here become parameters – their current values the defaults – so instances for other hosts, assets
 * or keys are created from it (Monitors → template → New from template).
 */
export function SaveAsTemplateModal({ monitor, unsaved, onClose }: { monitor: MonitorDetail; unsaved: boolean; onClose: () => void }) {
  const { t } = useTranslation(['monitors', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const rows = useMemo<Row[]>(
    () =>
      monitor.definition.checks.flatMap((c) =>
        Object.entries(c as unknown as Record<string, unknown>)
          .filter(([f, v]) => !NOT_PARAMETERS.has(f) && (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')))
          .map(([f, v]) => ({ checkId: c.id, checkName: c.name, field: f, value: String(v) })),
      ),
    [monitor],
  );
  const rowKey = (r: Row) => `${r.checkId}.${r.field}`;
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(rows.filter((r) => USUAL.test(r.field)).map(rowKey)));
  // the parameter of each field: the same name for the same field of several checks makes one parameter
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(rows.map((r) => [rowKey(r), r.field.replace(/[^A-Za-z0-9_]/g, '_')])));
  const [name, setName] = useState(t('editor.templateName', { name: monitor.name }));
  const [key, setKey] = useState(`${monitor.key}-template`.slice(0, 64));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parameters = useMemo<MonitorTemplateParamChoice[]>(() => {
    const byName = new Map<string, MonitorTemplateParamChoice>();
    for (const r of rows) {
      if (!chosen.has(rowKey(r))) continue;
      const n = names[rowKey(r)]!.trim();
      const p = byName.get(n) ?? { name: n, label: n, fields: [] };
      p.fields.push({ checkId: r.checkId, field: r.field });
      byName.set(n, p);
    }
    return [...byName.values()];
  }, [rows, chosen, names]);
  const badName = parameters.find((p) => !PARAM_NAME.test(p.name) || p.name === 'name' || p.name === 'key');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<DuplicateResult>(`/monitors/${monitor.id}/duplicate`, { name: name.trim(), key: key.trim(), template: { parameters } });
      void qc.invalidateQueries({ queryKey: ['monitors'] });
      notifyOk(t('editor.templateSaved', { name: r.name }));
      onClose();
      navigate(r.path);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setError(errorText(e));
      else notifyError(e, t('editor.templateNotSaved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} size="xl" title={t('editor.saveAsTemplate')} data-testid="save-as-template">
      <Stack gap="sm">
        <Text size="sm">{t('editor.saveAsTemplateIntro')}</Text>
        {unsaved && (
          <Alert color="orange" p="xs">
            {t('editor.saveAsTemplateUnsaved')}
          </Alert>
        )}
        <Group grow align="flex-start">
          <TextInput label={t('editor.templateNameLabel')} value={name} onChange={(e) => setName(e.currentTarget.value)} required />
          <TextInput
            label={t('editor.key')}
            value={key}
            onChange={(e) => setKey(e.currentTarget.value.toLowerCase())}
            classNames={{ input: 'mono' }}
            error={error ?? undefined}
            required
          />
        </Group>
        <Text size="sm" fw={500}>
          {t('editor.templateParams')}
        </Text>
        {rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('editor.templateNoFields')}
          </Text>
        ) : (
          <ScrollArea.Autosize mah={360}>
            <Table fz="sm" verticalSpacing={4} aria-label={t('editor.templateParams')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th />
                  <Table.Th>{t('detail.check')}</Table.Th>
                  <Table.Th>{t('editor.templateField')}</Table.Th>
                  <Table.Th>{t('editor.templateValue')}</Table.Th>
                  <Table.Th>{t('editor.templateParam')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => {
                  const k = rowKey(r);
                  const on = chosen.has(k);
                  const label = i18n.exists(`monitors:form.${r.field}`) ? t(`form.${r.field}` as 'form.name') : r.field;
                  return (
                    <Table.Tr key={k}>
                      <Table.Td>
                        <Checkbox
                          aria-label={t('editor.templateMakeParam', { field: label, check: r.checkName })}
                          checked={on}
                          onChange={(e) => {
                            const next = new Set(chosen);
                            if (e.currentTarget.checked) next.add(k);
                            else next.delete(k);
                            setChosen(next);
                          }}
                        />
                      </Table.Td>
                      <Table.Td>{r.checkName}</Table.Td>
                      <Table.Td>{label}</Table.Td>
                      <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                        {r.value}
                      </Table.Td>
                      <Table.Td>
                        <TextInput
                          size="xs"
                          aria-label={t('editor.templateParamOf', { field: label, check: r.checkName })}
                          disabled={!on}
                          value={names[k]}
                          onChange={(e) => setNames({ ...names, [k]: e.currentTarget.value })}
                          classNames={{ input: 'mono' }}
                        />
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        )}
        <Text size="xs" c="dimmed">
          {t('editor.templateParamsHint', { example: '{{ params.host }}' })}
        </Text>
        {badName && (
          <Text size="sm" c="red">
            {t('editor.templateBadParam', { name: badName.name })}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button leftSection={<IconTemplate size={14} />} loading={busy} disabled={!name.trim() || !key.trim() || !!badName} onClick={() => void save()}>
            {t('editor.saveAsTemplate')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
