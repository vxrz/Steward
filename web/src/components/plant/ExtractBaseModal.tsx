import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, List, Modal, MultiSelect, Select, Stack, Switch, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  PLANT_ID_RE,
  PLANT_LIMITS,
  PLANT_NAME_RE,
  type PlantExtractCandidates,
  type PlantExtractInput,
  type PlantExtractPreview,
  type PlantProtocol,
  type PlantProfileSummary,
} from '@sm/shared';
import { notifyError, post } from '../../api';
import { plantKeys } from '../../queryKeys';
import { IdInput, useIdField } from './forms';
import { TableScroll } from '../TableScroll';

/**
 * Extract a base profile (0.12.0, docs/PLANT.md "Extracting a base profile"): choose two or more profiles without a
 * base and the leading one, the data points they share (matched by id, known-as name and name – change a match by
 * hand), the base's id and name; the preview shows the renames, what each profile keeps as overrides and what is
 * refused; one click extracts it.
 */

interface Row {
  include: boolean;
  id: string;
  from: Record<string, string | null>;
}

export function ExtractBaseModal({ profiles, preselect, onClose }: { profiles: PlantProfileSummary[]; preselect?: string[]; onClose: () => void }) {
  const { t } = useTranslation(['plantModel', 'plant', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const free = profiles.filter((p) => !p.extends);
  const [chosen, setChosen] = useState<string[]>((preselect ?? []).filter((id) => free.some((p) => p.id === id)));
  const [leading, setLeading] = useState<string | null>(chosen[0] ?? null);
  const [name, setName] = useState('');
  const id = useIdField(undefined);
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  // 0.13: the base's id of each leading interface that holds shared data points (left out: the same)
  const [ifaceIds, setIfaceIds] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ key: string; result: PlantExtractPreview } | null>(null);
  const [busy, setBusy] = useState(false);
  const lead = leading && chosen.includes(leading) ? leading : null;
  const others = chosen.filter((x) => x !== lead);
  const candidates = useQuery({
    queryKey: [...plantKeys.profiles, 'extract-candidates', lead, ...chosen],
    queryFn: () => post<PlantExtractCandidates>('/plant/profiles/extract-base/candidates', { profiles: chosen, leading: lead }),
    enabled: !!lead && chosen.length >= 2,
  });
  // the leading profile's data points, matched in the others: included when every other profile has a match
  useEffect(() => {
    const c = candidates.data;
    if (!c) return;
    setRows(
      c.points.map((p) => ({
        include: others.every((o) => !!p.matches[o]),
        id: p.id,
        from: Object.fromEntries([[lead!, p.id], ...others.map((o) => [o, p.matches[o]?.id ?? null])]),
      })),
    );
    setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.data]);
  const input: PlantExtractInput | null = useMemo(() => {
    if (!lead || chosen.length < 2) return null;
    return {
      id: id.id,
      name: name.trim(),
      description,
      template,
      leading: lead,
      profiles: chosen,
      points: rows
        .filter((r) => r.include && others.every((o) => !!r.from[o]))
        .map((r) => ({ id: r.id.trim(), from: Object.fromEntries(Object.entries(r.from).filter(([, v]) => !!v)) as Record<string, string> })),
      ...(Object.entries(ifaceIds).some(([from, to]) => to.trim() && to.trim() !== from)
        ? {
            interfaces: Object.fromEntries(
              Object.entries(ifaceIds)
                .filter(([from, to]) => to.trim() && to.trim() !== from)
                .map(([f, x]) => [f, x.trim()]),
            ),
          }
        : {}),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead, chosen, rows, id.id, name, description, template, ifaceIds]);
  const key = JSON.stringify(input);
  const valid =
    !!input &&
    PLANT_ID_RE.test(input.id) &&
    !!input.name &&
    input.points.length > 0 &&
    input.points.every((p) => PLANT_NAME_RE.test(p.id)) &&
    Object.values(input.interfaces ?? {}).every((x) => PLANT_NAME_RE.test(x));
  // 0.13: the leading interfaces that hold shared data points, with each profile's protocol there
  const sharedIfaces = (() => {
    const c = candidates.data;
    if (!c || !lead) return [];
    const ifaceOf = (pid: string, point: string | null) => c.profiles.find((p) => p.id === pid)?.dataPoints.find((d) => d.id === point)?.interface;
    const protocolOf = (pid: string, iface: string | undefined) => c.profiles.find((p) => p.id === pid)?.interfaces.find((i) => i.id === iface)?.protocol;
    const out = new Map<string, Set<string>>();
    rows.forEach((r, i) => {
      if (!r.include || !others.every((o) => !!r.from[o])) return;
      const li = c.points[i]!.interface;
      const set = out.get(li) ?? new Set<string>();
      set.add(c.points[i]!.protocol);
      for (const o of others) {
        const pr = protocolOf(o, ifaceOf(o, r.from[o] ?? null));
        if (pr) set.add(pr);
      }
      out.set(li, set);
    });
    return [...out].map(([iface, protocols]) => ({ iface, protocols: [...protocols] }));
  })();
  const current = preview && preview.key === key ? preview.result : null;
  const problemOf = new Map((current?.points ?? []).map((p) => [p.id, p.problem]));
  const optionsOf = (profileId: string) =>
    (candidates.data?.profiles.find((p) => p.id === profileId)?.dataPoints ?? []).map((d) => ({
      value: d.id,
      label: `${d.name} (${d.id}${d.unit ? `, ${d.unit}` : ''})`,
    }));
  const nameOf = (pid: string) => profiles.find((p) => p.id === pid)?.name ?? pid;
  const setRow = (i: number, r: Partial<Row>) => setRows((list) => list.map((x, j) => (j === i ? { ...x, ...r } : x)));
  const run = async (apply: boolean) => {
    if (!input) return;
    setBusy(true);
    try {
      if (!apply) setPreview({ key, result: await post<PlantExtractPreview>('/plant/profiles/extract-base/preview', input) });
      else {
        await post<PlantExtractPreview>('/plant/profiles/extract-base', input);
        void qc.invalidateQueries({ queryKey: plantKeys.all });
        onClose();
        navigate(`/plant/profiles/${encodeURIComponent(input.id)}`);
      }
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy(false);
    }
  };
  const matchBy = (pointId: string, other: string) => candidates.data?.points.find((p) => p.id === pointId)?.matches[other] ?? null;
  return (
    <Modal opened onClose={onClose} size="80rem" title={t('extract.title')} data-testid="extract-base">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('extract.help')}
        </Text>
        <Group gap="sm" align="flex-end" wrap="wrap">
          <MultiSelect
            label={t('extract.profiles')}
            description={t('extract.profilesHelp')}
            data={profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.id})`, disabled: !!p.extends }))}
            value={chosen}
            onChange={(v) => {
              setChosen(v);
              if (!leading || !v.includes(leading)) setLeading(v[0] ?? null);
            }}
            searchable
            maxValues={20}
            w={{ base: '100%', sm: 420 }}
            data-testid="extract-profiles"
          />
          <Select
            label={t('extract.leading')}
            description={t('extract.leadingHelp')}
            data={chosen.map((x) => ({ value: x, label: nameOf(x) }))}
            value={lead}
            onChange={setLeading}
            allowDeselect={false}
            w={{ base: '100%', sm: 260 }}
            data-testid="extract-leading"
          />
        </Group>
        {chosen.length >= 2 && candidates.data && (
          <>
            <Text size="sm" fw={600}>
              {t('extract.points')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('extract.pointsHelp')}
            </Text>
            <TableScroll>
              <Table fz="xs" withTableBorder data-testid="extract-points" aria-label={t('extract.points')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={36}>
                      <Checkbox
                        aria-label={t('extract.all')}
                        checked={rows.length > 0 && rows.every((r) => r.include)}
                        indeterminate={rows.some((r) => r.include) && !rows.every((r) => r.include)}
                        onChange={(e) => setRows((list) => list.map((r) => ({ ...r, include: e.currentTarget.checked })))}
                      />
                    </Table.Th>
                    <Table.Th>{t('extract.baseId')}</Table.Th>
                    <Table.Th>{nameOf(lead!)}</Table.Th>
                    {others.map((o) => (
                      <Table.Th key={o}>{nameOf(o)}</Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((r, i) => {
                    const p = candidates.data!.points[i]!;
                    const problem = problemOf.get(r.id.trim());
                    return (
                      <Table.Tr key={p.id} data-testid={`extract-row-${p.id}`}>
                        <Table.Td>
                          <Checkbox
                            aria-label={t('extract.include', { point: p.id })}
                            checked={r.include}
                            onChange={(e) => setRow(i, { include: e.currentTarget.checked })}
                          />
                        </Table.Td>
                        <Table.Td>
                          <TextInput
                            size="xs"
                            aria-label={t('extract.baseIdOf', { point: p.id })}
                            value={r.id}
                            onChange={(e) => setRow(i, { id: e.currentTarget.value })}
                            classNames={{ input: 'mono' }}
                            error={r.include && !PLANT_NAME_RE.test(r.id.trim()) ? t('plant:form.idInvalid') : undefined}
                            w={170}
                          />
                          {r.include && problem && (
                            <Text size="xs" c="red.8" mt={2} data-testid={`extract-problem-${p.id}`}>
                              {t(`extract.problems.${problem.code}`, { ...problem.params, defaultValue: problem.message })}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{p.name}</Text>
                          <Text size="xs" c="dimmed" className="mono">
                            {p.id}
                            {p.unit ? ` · ${p.unit}` : ''} · {p.interface}
                          </Text>
                        </Table.Td>
                        {others.map((o) => {
                          const m = matchBy(p.id, o);
                          return (
                            <Table.Td key={o}>
                              <Select
                                size="xs"
                                aria-label={t('extract.matchIn', { point: p.id, profile: nameOf(o) })}
                                data={optionsOf(o)}
                                value={r.from[o] ?? null}
                                onChange={(v) => setRow(i, { from: { ...r.from, [o]: v } })}
                                searchable
                                clearable
                                placeholder={t('extract.noMatch')}
                                w={220}
                                data-testid={`extract-match-${p.id}-${o}`}
                              />
                              {m && m.id === r.from[o] && (
                                <Group gap={2} mt={2}>
                                  {m.by.map((b) => (
                                    <Badge key={b} size="xs" variant="light" color="gray" tt="none">
                                      {t(`extract.by.${b}`)}
                                    </Badge>
                                  ))}
                                </Group>
                              )}
                            </Table.Td>
                          );
                        })}
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </TableScroll>
            {sharedIfaces.length > 0 && (
              <Stack gap={4} data-testid="extract-interfaces">
                <Text size="sm" fw={600}>
                  {t('extract.interfaces')}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('extract.interfacesHelp')}
                </Text>
                {sharedIfaces.map((x) => {
                  const value = ifaceIds[x.iface] ?? x.iface;
                  return (
                    <Group key={x.iface} gap="sm" align="flex-start" wrap="wrap">
                      <TextInput
                        size="xs"
                        label={t('extract.interfaceId', { interface: x.iface })}
                        value={value}
                        onChange={(e) => setIfaceIds((m) => ({ ...m, [x.iface]: e.currentTarget.value }))}
                        classNames={{ input: 'mono' }}
                        error={!PLANT_NAME_RE.test(value.trim()) ? t('plant:form.idInvalid') : undefined}
                        w={220}
                        data-testid={`extract-interface-${x.iface}`}
                      />
                      {x.protocols.length > 1 && (
                        <Text size="xs" c="dimmed" mt={26} data-testid={`extract-mixed-${x.iface}`}>
                          {t('extract.mixed', { protocols: x.protocols.map((p) => t(`plant:data.protocols.${p as PlantProtocol}`)).join(', ') })}
                        </Text>
                      )}
                    </Group>
                  );
                })}
              </Stack>
            )}
            <Group gap="sm" align="flex-start" wrap="wrap">
              <TextInput
                label={t('extract.name')}
                required
                maxLength={PLANT_LIMITS.name}
                value={name}
                onChange={(e) => {
                  setName(e.currentTarget.value);
                  id.follow(e.currentTarget.value);
                }}
                w={{ base: '100%', sm: 280 }}
                data-testid="extract-name"
              />
              <div style={{ width: 280, maxWidth: '100%' }}>
                <IdInput value={id.id} onChange={id.set} disabled={false} error={id.id && !PLANT_ID_RE.test(id.id) ? t('plant:form.idInvalid') : undefined} />
              </div>
            </Group>
            <Textarea
              label={t('plant:form.description')}
              autosize
              minRows={1}
              maxRows={4}
              maxLength={8000}
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />
            <Switch
              label={t('template.label')}
              description={t('extract.templateHelp')}
              checked={template}
              onChange={(e) => setTemplate(e.currentTarget.checked)}
              data-testid="extract-template"
            />
            {current && <PreviewResult preview={current} nameOf={nameOf} />}
          </>
        )}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button variant="light" disabled={!valid} loading={busy && !current} onClick={() => void run(false)} data-testid="extract-preview">
            {t('extract.preview')}
          </Button>
          <Button disabled={!valid || !current?.ok} loading={busy && !!current} onClick={() => void run(true)} data-testid="extract-apply">
            {t('extract.apply')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PreviewResult({ preview: p, nameOf }: { preview: PlantExtractPreview; nameOf: (id: string) => string }) {
  const { t } = useTranslation('plantModel');
  const refused = p.points.filter((x) => x.problem).length;
  return (
    <Stack gap="xs" data-testid="extract-result">
      {p.problems.map((x, i) => (
        <Alert key={i} color="red" icon={<IconAlertTriangle size={16} />} data-testid="extract-refused">
          {t(`extract.problems.${x.code}`, { ...x.params, defaultValue: x.message })}
        </Alert>
      ))}
      {refused > 0 && (
        <Alert color="orange" icon={<IconAlertTriangle size={16} />}>
          {t('extract.refusedPoints', { count: refused })}
        </Alert>
      )}
      {p.ok && (
        <Alert color="green" icon={<IconCircleCheck size={16} />} data-testid="extract-ok">
          {t('extract.ok', { points: p.points.length, interfaces: p.base.interfaces.length })}
        </Alert>
      )}
      {p.profiles.length > 0 && (
        <List size="sm" spacing={4}>
          {p.profiles.map((x) => (
            <List.Item key={x.id}>
              <Text size="sm" fw={500} span>
                {nameOf(x.id)}
              </Text>
              <Text size="xs" c="dimmed">
                {t('extract.summary', {
                  renames: x.renames.length,
                  overrides: x.pointOverrides.length,
                  interfaces: x.own.interfaces,
                  points: x.own.points,
                  assets: x.assets,
                })}
              </Text>
              {x.renames.length > 0 && (
                <Text size="xs" className="mono">
                  {x.renames.map((r) => `${r.from} → ${r.to}`).join(', ')}
                </Text>
              )}
              {x.pointOverrides.length > 0 && (
                <Text size="xs" c="dimmed">
                  {t('extract.differs', {
                    list: x.pointOverrides
                      .slice(0, 8)
                      .map((o) => `${o.dataPoint} (${o.fields.join(', ')})`)
                      .join('; '),
                  })}
                </Text>
              )}
            </List.Item>
          ))}
        </List>
      )}
    </Stack>
  );
}
