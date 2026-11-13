import { useState } from 'react';
import { ActionIcon, Anchor, Button, Group, Paper, SegmentedControl, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DATA_ROPA_LIMITS, DATA_TRANSFER_SAFEGUARDS, type DataRopaDetails, type DataTransfer, type DataTransferSafeguard } from '@sm/shared';
import { put } from '../../../api';
import { FormModal } from '../../../components/FormModal';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { dpKeys } from '../api';
import { Section } from '../parts';
import { useRopaDetails } from './api';

const enc = encodeURIComponent;
type Kind = 'data-products' | 'data-objects';

/**
 * The GDPR Art. 30 details of a data object or a product (0.25.0): transfers to third countries with their safeguards
 * (Art. 30(1)(e)) and the reference to the technical and organisational measures (Art. 30(1)(g)) – a link or a document
 * of Steward. Shown under Data → Records of processing; changed by who may change the item.
 */
export function RopaDetailsSection({ kind, id, name }: { kind: Kind; id: string; name: string }) {
  const { t } = useTranslation('dataProductSemantic');
  const q = useRopaDetails(kind, id);
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const v = q.data;
  if (!v) return null;
  return (
    <Section
      title={t('ropa.title')}
      testId="ropa-details"
      actions={
        v.mayEdit && (
          <Button
            size="xs"
            variant="default"
            leftSection={<IconPencil size={14} />}
            onClick={() => setEditing(true)}
            aria-label={t('ropa.editNamed', { name })}
            data-testid="ropa-details-edit"
          >
            {t('ropa.edit')}
          </Button>
        )
      }
    >
      <Stack gap={6}>
        <Text size="xs" c="dimmed">
          {t('ropa.help')}
        </Text>
        <div>
          <Text size="xs" c="dimmed">
            {t('ropa.transfers')}
          </Text>
          {v.transfers.length ? (
            v.transfers.map((x, i) => (
              <Text key={`${x.country}${i}`} size="sm" data-testid="ropa-transfer" style={{ overflowWrap: 'anywhere' }}>
                {[`${x.country}${x.recipient ? ` (${x.recipient})` : ''}`, t(`ropa.safeguards.${x.safeguard}`), x.note].filter(Boolean).join(' – ')}
              </Text>
            ))
          ) : (
            <Text size="sm" c="dimmed">
              {t('ropa.noTransfers')}
            </Text>
          )}
        </div>
        <div>
          <Text size="xs" c="dimmed">
            {t('ropa.toms')}
          </Text>
          <Text size="sm" data-testid="ropa-toms" style={{ overflowWrap: 'anywhere' }}>
            {!v.toms ? (
              <Text span size="sm" c="dimmed">
                {t('ropa.noToms')}
              </Text>
            ) : v.toms.kind === 'url' ? (
              <Anchor href={v.toms.url} target="_blank" rel="noopener noreferrer" size="sm">
                {v.toms.label || v.toms.url}
              </Anchor>
            ) : 'hidden' in v.toms ? (
              <Text span size="sm" c="dimmed" fs="italic">
                {t('ropa.hiddenRecord')}
              </Text>
            ) : (
              <Anchor component={Link} to={`/records/${enc(v.toms.id)}`} size="sm">
                {v.toms.number} {v.toms.title}
              </Anchor>
            )}
          </Text>
        </div>
      </Stack>
      {editing && (
        <RopaForm
          kind={kind}
          id={id}
          name={name}
          details={v}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: dpKeys.all });
          }}
        />
      )}
    </Section>
  );
}

type TomsKind = 'none' | 'url' | 'record';

function RopaForm({
  kind,
  id,
  name,
  details,
  onClose,
  onSaved,
}: {
  kind: Kind;
  id: string;
  name: string;
  details: DataRopaDetails;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProductSemantic', 'common']);
  const [transfers, setTransfers] = useState<DataTransfer[]>(details.transfers);
  const t0 = details.toms;
  const [tomsKind, setTomsKind] = useState<TomsKind>(!t0 ? 'none' : t0.kind);
  const [url, setUrl] = useState(t0?.kind === 'url' ? t0.url : '');
  const [label, setLabel] = useState(t0?.kind === 'url' ? t0.label : '');
  const [record, setRecord] = useState(t0?.kind === 'record' && !('hidden' in t0) ? t0.number : '');
  const [dirty, setDirty] = useState(false);
  const [busy, run] = useBusy();
  const change = (i: number, patch: Partial<DataTransfer>) => {
    setDirty(true);
    setTransfers((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };
  const keepHiddenRecord = t0?.kind === 'record' && 'hidden' in t0;
  const save = () =>
    run(async () => {
      const toms =
        tomsKind === 'url'
          ? { kind: 'url', url: url.trim(), label: label.trim() }
          : tomsKind === 'record'
            ? record.trim()
              ? { kind: 'record', recordId: record.trim() }
              : undefined
            : null;
      await put(`/${kind}/${enc(id)}/ropa-details`, {
        transfers: transfers.map((x) => ({ ...x, country: x.country.trim(), recipient: x.recipient.trim(), note: x.note.trim() })),
        // a document the person may not see stays as it is (it is not shown, so it cannot be sent back)
        ...(toms === undefined && keepHiddenRecord ? {} : { toms: toms ?? null }),
      });
      onSaved();
    });
  return (
    <FormModal onClose={onClose} title={t('ropa.formTitle', { name })} size="lg" dirty={dirty}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" fw={600}>
            {t('ropa.transfers')}
          </Text>
          {transfers.map((x, i) => (
            <Paper key={i} withBorder p="xs" data-testid="ropa-transfer-row">
              <Stack gap="xs">
                <Group justify="space-between" gap="xs">
                  <Text size="sm">{t('ropa.transferN', { n: i + 1 })}</Text>
                  <Tooltip label={t('ropa.remove', { n: i + 1 })}>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={t('ropa.remove', { n: i + 1 })}
                      onClick={() => {
                        setDirty(true);
                        setTransfers((xs) => xs.filter((_, j) => j !== i));
                      }}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <TextInput
                  label={t('ropa.country')}
                  value={x.country}
                  onChange={(e) => change(i, { country: e.currentTarget.value })}
                  required
                  maxLength={100}
                  data-testid="ropa-country"
                />
                <TextInput label={t('ropa.recipient')} value={x.recipient} onChange={(e) => change(i, { recipient: e.currentTarget.value })} maxLength={200} />
                <Select
                  label={t('ropa.safeguard')}
                  data={DATA_TRANSFER_SAFEGUARDS.map((s) => ({ value: s, label: t(`ropa.safeguards.${s}`) }))}
                  value={x.safeguard}
                  onChange={(s) => s && change(i, { safeguard: s as DataTransferSafeguard })}
                  allowDeselect={false}
                  data-testid="ropa-safeguard"
                />
                <TextInput label={t('ropa.note')} value={x.note} onChange={(e) => change(i, { note: e.currentTarget.value })} maxLength={500} />
              </Stack>
            </Paper>
          ))}
          {transfers.length < DATA_ROPA_LIMITS.transfers && (
            <Group>
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPlus size={14} />}
                onClick={() => {
                  setDirty(true);
                  setTransfers((xs) => [...xs, { country: '', recipient: '', safeguard: 'scc', note: '' }]);
                }}
                data-testid="ropa-transfer-add"
              >
                {t('ropa.add')}
              </Button>
            </Group>
          )}
          <Text size="sm" fw={600}>
            {t('ropa.toms')}
          </Text>
          <SegmentedControl
            aria-label={t('ropa.tomsKind')}
            value={tomsKind}
            onChange={(v) => {
              setDirty(true);
              setTomsKind(v as TomsKind);
            }}
            data={[
              { value: 'none', label: t('ropa.tomsNone') },
              { value: 'url', label: t('ropa.tomsUrl') },
              { value: 'record', label: t('ropa.tomsRecord') },
            ]}
            data-testid="ropa-toms-kind"
          />
          {tomsKind === 'url' && (
            <>
              <TextInput
                label={t('ropa.url')}
                value={url}
                onChange={(e) => (setDirty(true), setUrl(e.currentTarget.value))}
                required
                type="url"
                data-testid="ropa-toms-url"
              />
              <TextInput label={t('ropa.label')} value={label} onChange={(e) => (setDirty(true), setLabel(e.currentTarget.value))} maxLength={200} />
            </>
          )}
          {tomsKind === 'record' && (
            <TextInput
              label={t('ropa.record')}
              description={t('ropa.recordHelp')}
              value={record}
              onChange={(e) => (setDirty(true), setRecord(e.currentTarget.value))}
              placeholder={keepHiddenRecord ? t('ropa.hiddenRecord') : undefined}
              data-testid="ropa-toms-record"
            />
          )}
          <FormButtons busy={busy} testId="ropa-details-save" />
        </Stack>
      </form>
    </FormModal>
  );
}
