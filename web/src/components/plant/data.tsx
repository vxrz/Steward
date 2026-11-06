import type { ReactNode } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Menu, Paper, Stack, Table, Text, TextInput, Textarea, ThemeIcon, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCheck, IconDots, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { modbusAddress, unitSymbol, type KpiParamValue, type PlantAssetBrief, type PlantCheck, type PlantDataPoint, type PlantProtocol } from '@sm/shared';
import { AssetStatusBadge, useNameOf } from './common';

/**
 * Building blocks of part 2 of the plant registry (#219): protocols, units, data point tables (cards on phones),
 * the checks as plain sentences, and a small editor for rows of text fields.
 */

const PROTOCOL_COLOR: Record<PlantProtocol, string> = {
  opc_ua: 'blue',
  modbus_tcp: 'grape',
  mqtt: 'teal',
  http: 'gray',
  smb: 'orange',
  webdav: 'orange',
  sftp: 'orange',
  ftp: 'orange',
  other: 'gray',
};

export function ProtocolBadge({ protocol, size = 'sm' }: { protocol: PlantProtocol; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plant');
  return (
    <Badge color={PROTOCOL_COLOR[protocol]} variant="light" size={size} style={{ minWidth: 'max-content' }}>
      {t(`data.protocols.${protocol}`)}
    </Badge>
  );
}

/** A unit by its symbol; the UCUM code shows on hover when it differs. */
export function UnitText({ unit }: { unit: string }) {
  if (!unit) return <>–</>;
  const symbol = unitSymbol(unit);
  return symbol === unit ? (
    <span>{unit}</span>
  ) : (
    <Tooltip label={`UCUM: ${unit}`} withArrow>
      <span tabIndex={0}>{symbol}</span>
    </Tooltip>
  );
}

/** What a Modbus address means: the table, the registers and the function code that reads it. */
export function useAddressHint() {
  const { t } = useTranslation('plant');
  return (protocol: PlantProtocol, address: string): string | null => {
    if (protocol !== 'modbus_tcp') return null;
    const m = modbusAddress(address);
    if (!m) return null;
    return t('data.modbusHint', {
      table: t(`data.modbusTables.${m.table}`),
      from: m.address,
      to: m.address + m.count - 1,
      count: m.count,
      code: String(m.readCode).padStart(2, '0'),
    });
  };
}

/**
 * An identifier, address or path that may wrap after its separators (ns=2;s=Channel1.Status), not inside a word. In a
 * table sized by its content (.code-keep) its parts never break – not even at a hyphen – and the table scrolls instead.
 */
export function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[;./:,_])/);
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className="code-part">
          {p}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </>
  );
}

export const rateText = (ms: number | null, lang: string): string => {
  if (ms === null) return '–';
  const fmt = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 });
  return ms >= 1000 ? `${fmt.format(ms / 1000)} s` : `${fmt.format(ms)} ms`;
};

export function AssetBriefLink({ asset, withSite = true }: { asset: PlantAssetBrief; withSite?: boolean }) {
  const nameOf = useNameOf();
  return (
    <Group gap={6} wrap="wrap">
      <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(asset.id)}`} size="sm" fw={500}>
        {asset.name}
      </Anchor>
      <AssetStatusBadge status={asset.status} size="xs" />
      {withSite && (
        <Text size="xs" c="dimmed">
          {nameOf(asset.site)}
        </Text>
      )}
    </Group>
  );
}

/** A check as a sentence in the UI language. */
export function useCheckText() {
  const { t } = useTranslation('plant');
  return (c: PlantCheck) => t(`checks.codes.${c.code}`, { ...c.params, defaultValue: c.message });
}

/** Checks as a list: what is wrong, on which record and KPI instance. */
export function ChecksList({ checks, subjects = false, testId }: { checks: PlantCheck[]; subjects?: boolean; testId?: string }) {
  const { t } = useTranslation('plant');
  const text = useCheckText();
  if (!checks.length) return null;
  return (
    <Stack gap={6} data-testid={testId ?? 'plant-checks'} role="list">
      {checks.map((c, i) => (
        <Group key={`${c.subject.id}:${c.job ?? ''}:${c.code}:${i}`} gap="xs" wrap="nowrap" align="flex-start" role="listitem">
          <ThemeIcon color="orange" variant="light" size="sm" mt={2} aria-hidden>
            <IconAlertTriangle size={14} />
          </ThemeIcon>
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
              {text(c)}
            </Text>
            {(subjects || c.job) && (
              <Group gap={6} wrap="wrap">
                {subjects && (
                  <Anchor
                    component={Link}
                    size="xs"
                    to={c.subject.kind === 'asset' ? `/plant/assets/${encodeURIComponent(c.subject.id)}` : `/plant/kpis/${encodeURIComponent(c.subject.id)}`}
                  >
                    {c.subject.kind === 'asset' ? t('checks.onAsset', { name: c.subject.name }) : t('checks.onKpi', { name: c.subject.name })}
                  </Anchor>
                )}
                {c.job && (
                  <Text size="xs" c="dimmed">
                    {t('checks.job')} <span className="mono">{c.job}</span>
                  </Text>
                )}
              </Group>
            )}
          </Stack>
        </Group>
      ))}
    </Stack>
  );
}

/** Nothing to report. */
export function NoProblems({ text }: { text: string }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <ThemeIcon color="green" variant="light" size="sm" aria-hidden>
        <IconCheck size={14} />
      </ThemeIcon>
      <Text size="sm">{text}</Text>
    </Group>
  );
}

/** KPI instance parameters as name = value. */
export function ParamsView({ params }: { params: Record<string, KpiParamValue> }) {
  const entries = Object.entries(params);
  if (!entries.length) return <>–</>;
  return (
    <Group gap={4} wrap="wrap">
      {entries.map(([k, v]) => (
        <Badge key={k} variant="default" size="sm" tt="none" style={{ maxWidth: '100%' }}>
          <span className="mono">
            {k} = {v === null ? '–' : String(v)}
          </span>
        </Badge>
      ))}
    </Group>
  );
}

/** Row actions: edit and remove behind one button. */
export function RowMenu({ label, onEdit, onRemove, extra }: { label: string; onEdit?: () => void; onRemove?: () => void; extra?: ReactNode }) {
  const { t } = useTranslation('common');
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" aria-label={label}>
          <IconDots size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {onEdit && (
          <Menu.Item leftSection={<IconEdit size={14} />} onClick={onEdit}>
            {t('edit')}
          </Menu.Item>
        )}
        {extra}
        {onRemove && (
          <Menu.Item leftSection={<IconTrash size={14} />} color="red" onClick={onRemove}>
            {t('remove')}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/** The data points of a group: a table on wide screens, cards on phones; each opens the data point's page. */
export function DataPointTable({
  profileId,
  protocol,
  points,
  label,
  canManage,
  onEdit,
  onRemove,
}: {
  profileId: string;
  protocol: PlantProtocol;
  points: PlantDataPoint[];
  label: string;
  canManage: boolean;
  onEdit: (p: PlantDataPoint) => void;
  onRemove: (p: PlantDataPoint) => void;
}) {
  const { t, i18n } = useTranslation('plant');
  const hint = useAddressHint();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const to = (p: PlantDataPoint) => `/plant/profiles/${encodeURIComponent(profileId)}/points/${encodeURIComponent(p.id)}`;
  const menu = (p: PlantDataPoint) =>
    canManage && <RowMenu label={t('data.pointActions', { name: p.name })} onEdit={() => onEdit(p)} onRemove={() => onRemove(p)} />;
  if (!points.length)
    return (
      <Text size="sm" c="dimmed">
        {t('data.noPoints')}
      </Text>
    );
  if (narrow)
    return (
      <Stack gap="xs" role="list" aria-label={label} data-testid="data-point-cards">
        {points.map((p) => (
          <Paper key={p.id} withBorder p="sm" role="listitem">
            <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Anchor component={Link} to={to(p)} fw={500} size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {p.name}
                </Anchor>
                <Text size="xs" c="dimmed" className="mono code-wrap">
                  <Breakable text={p.id} />
                </Text>
              </Stack>
              {menu(p)}
            </Group>
            <Group gap="xs" mt={4} wrap="wrap">
              {p.dataType && (
                <Badge size="xs" variant="default" tt="none">
                  {p.dataType}
                </Badge>
              )}
              {p.unit && (
                <Badge size="xs" variant="default" tt="none">
                  <UnitText unit={p.unit} />
                </Badge>
              )}
              {p.access !== 'read' && (
                <Badge size="xs" variant="light" color="orange">
                  {t(`data.directions.${p.access}`)}
                </Badge>
              )}
              <Text size="xs" c="dimmed">
                {rateText(p.updateRateMs, i18n.language)}
              </Text>
            </Group>
            {p.address && (
              <Text size="xs" className="mono code-wrap" mt={4}>
                <Breakable text={p.address} />
              </Text>
            )}
          </Paper>
        ))}
      </Stack>
    );
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={label}>
      {/* the same column widths in every group of the profile */}
      <Table fz="sm" aria-label={label} data-testid="data-point-table" highlightOnHover layout="fixed" miw={640}>
        <colgroup>
          <col style={{ width: '27%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '8%' }} />
          <col style={{ width: '27%' }} />
          <col style={{ width: '13%' }} />
          <col style={{ width: '9%' }} />
          {canManage && <col style={{ width: 40 }} />}
        </colgroup>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('data.point')}</Table.Th>
            <Table.Th>{t('data.dataType')}</Table.Th>
            <Table.Th>{t('data.unit')}</Table.Th>
            <Table.Th>{t('data.address')}</Table.Th>
            <Table.Th>{t('data.access')}</Table.Th>
            <Table.Th>{t('data.updateRate')}</Table.Th>
            {canManage && <Table.Th aria-label={t('actions')} />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {points.map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td>
                <Anchor component={Link} to={to(p)} fw={500} size="sm">
                  {p.name}
                </Anchor>
                <Text size="xs" c="dimmed" className="mono code-wrap">
                  <Breakable text={p.id} />
                </Text>
              </Table.Td>
              <Table.Td className="mono code-wrap">
                <Breakable text={p.dataType || '–'} />
              </Table.Td>
              <Table.Td>
                <UnitText unit={p.unit} />
              </Table.Td>
              <Table.Td>
                <Text size="sm" className="mono code-wrap">
                  {p.address ? <Breakable text={p.address} /> : '–'}
                </Text>
                {hint(protocol, p.address) && (
                  <Text size="xs" c="dimmed">
                    {hint(protocol, p.address)}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>{t(`data.directions.${p.access}`)}</Table.Td>
              <Table.Td className="nowrap">{rateText(p.updateRateMs, i18n.language)}</Table.Td>
              {canManage && <Table.Td>{menu(p)}</Table.Td>}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

export interface RowField<T> {
  key: keyof T & string;
  label: string;
  long?: boolean;
  mono?: boolean;
  required?: boolean;
  max?: number;
}

/** Rows of text fields to add and remove (computation steps, publications …). */
export function RowsEditor<T extends Record<string, string>>({
  title,
  help,
  value,
  onChange,
  fields,
  empty,
  addLabel,
  removeLabel,
  max = 50,
}: {
  title: string;
  help?: string;
  value: T[];
  onChange: (v: T[]) => void;
  fields: RowField<T>[];
  empty: () => T;
  addLabel: string;
  removeLabel: (i: number) => string;
  max?: number;
}) {
  const set = (i: number, k: keyof T, v: string) => onChange(value.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Stack gap="xs">
      <div>
        <Text size="sm" fw={500}>
          {title}
        </Text>
        {help && (
          <Text size="xs" c="dimmed">
            {help}
          </Text>
        )}
      </div>
      {value.map((row, i) => (
        <Paper key={i} withBorder p="xs">
          <Group gap="xs" align="flex-end" wrap="wrap">
            {fields.map((f) =>
              f.long ? (
                <Textarea
                  key={f.key}
                  size="xs"
                  label={f.label}
                  autosize
                  minRows={1}
                  maxRows={4}
                  maxLength={f.max ?? 8000}
                  required={f.required}
                  value={row[f.key]}
                  onChange={(e) => set(i, f.key, e.currentTarget.value)}
                  style={{ flex: '2 1 220px' }}
                />
              ) : (
                <TextInput
                  key={f.key}
                  size="xs"
                  label={f.label}
                  maxLength={f.max ?? 200}
                  required={f.required}
                  classNames={f.mono ? { input: 'mono' } : undefined}
                  value={row[f.key]}
                  onChange={(e) => set(i, f.key, e.currentTarget.value)}
                  style={{ flex: '1 1 140px' }}
                />
              ),
            )}
            <ActionIcon variant="subtle" color="red" mb={2} aria-label={removeLabel(i)} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        </Paper>
      ))}
      <Button
        size="xs"
        variant="default"
        w="fit-content"
        leftSection={<IconPlus size={14} />}
        onClick={() => onChange([...value, empty()])}
        disabled={value.length >= max}
      >
        {addLabel}
      </Button>
    </Stack>
  );
}
