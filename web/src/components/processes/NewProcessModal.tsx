import { useState } from 'react';
import { Button, Group, Modal, MultiSelect, SegmentedControl, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconPlus } from '@tabler/icons-react';
import type { NewResourceTeams, ProcessDefinition, ProcessDetail, ProcessTemplate, Team } from '@sm/shared';
import { ApiError, get, notifyError, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { errorText } from '../../i18n/errors';
import { useMe } from '../../auth';
import { processKeys } from '../../queryKeys';

export type NewProcessStart = 'blank' | 'manual' | 'template';

/** The id the server derives from a name (server/src/util.ts slugify). */
export const processIdOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/**
 * "New process" (U7 of the 0.10 review): name, id, description, how to start and the owning teams – nothing is saved
 * until the person confirms. Starts blank, as a manual procedure or as a copy of a template.
 */
export function NewProcessModal({ opened, onClose, initialStart = 'blank' }: { opened: boolean; onClose: () => void; initialStart?: NewProcessStart }) {
  const { t } = useTranslation(['processes', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isAdmin } = useMe();
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [start, setStart] = useState<NewProcessStart>(initialStart);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastStart, setLastStart] = useState(initialStart);
  // opened again from another menu entry: start where that entry points
  if (initialStart !== lastStart) {
    setLastStart(initialStart);
    setStart(initialStart);
    if (initialStart === 'manual' && !name.trim()) setName(t('manualTemplate.name'));
  }
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => get<ProcessTemplate[]>('/templates'),
    enabled: opened && start === 'template',
  });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams'), enabled: opened && isAdmin });
  const mine = useQuery({ queryKey: ['new-resource-teams'], queryFn: () => get<NewResourceTeams>('/me/new-resource-teams'), enabled: opened && !isAdmin });
  const tpl = templates.data?.find((x) => x.id === templateId);
  const effectiveId = idTouched ? id : processIdOf(name);

  // the id the server refused (taken): shown on the field until it changes
  const [takenId, setTakenId] = useState<string | null>(null);
  const check = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !ID_RE.test(effectiveId) && t('create.idInvalid'),
    template: start === 'template' && !tpl && t('common:validation.required'),
  });
  const idError =
    check.error('id') ?? (takenId && takenId === effectiveId ? errorText(new ApiError(409, '', undefined, 'PROCESS_ID_TAKEN', { id: takenId })) : undefined);

  const close = () => {
    setName('');
    setId('');
    setIdTouched(false);
    setDescription('');
    setStart(initialStart);
    setTemplateId(null);
    setTeamIds([]);
    setTakenId(null);
    check.reset();
    onClose();
  };

  const definitionFor = (): ProcessDefinition => {
    const base = { name: name.trim(), description: description.trim() };
    if (start === 'template' && tpl) return { ...structuredClone(tpl.definition), ...base, description: base.description || tpl.definition.description || '' };
    if (start === 'manual')
      return {
        ...manualDefinition({
          instructions: t('manualTemplate.instructions'),
          prepare: t('manualTemplate.prepare'),
          prepareItems: [t('manualTemplate.prepareItem1'), t('manualTemplate.prepareItem2')],
          carryOut: t('manualTemplate.carryOut'),
          carryOutItems: [t('manualTemplate.carryOutItem1')],
          ticket: t('manualTemplate.ticket'),
          check: t('manualTemplate.check'),
          checkItems: [t('manualTemplate.checkItem1')],
        }),
        ...base,
        description: base.description || t('manualTemplate.description'),
      };
    return { ...base, connections: [], inputs: [], nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }], wires: [] } as ProcessDefinition;
  };

  const create = async () => {
    if (!check.validate()) return;
    setBusy(true);
    try {
      const body = { definition: definitionFor(), comment: start === 'template' && tpl ? `Created from template ${tpl.id}` : 'Created' };
      let p: ProcessDetail;
      try {
        p = await post<ProcessDetail>('/processes', { ...body, id: effectiveId });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'PROCESS_ID_TAKEN') throw e;
        // an id the person typed: they choose another; one derived from the name: the server numbers it (name-2)
        if (idTouched) {
          setTakenId(effectiveId);
          return;
        }
        p = await post<ProcessDetail>('/processes', body);
      }
      if (isAdmin && teamIds.length) await put(`/owning-teams/process/${p.id}`, { teamIds }).catch(notifyError);
      void qc.invalidateQueries({ queryKey: processKeys.all });
      close();
      navigate(`/processes/${p.id}`);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('create.title')} size="lg">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <Stack>
          <TextInput
            data-autofocus
            label={t('create.name')}
            withAsterisk
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={check.error('name')}
            maxLength={200}
          />
          <TextInput
            label={t('create.id')}
            description={t('create.idHint')}
            withAsterisk
            classNames={{ input: 'mono' }}
            value={effectiveId}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.currentTarget.value.toLowerCase());
            }}
            error={idError}
            maxLength={48}
          />
          <Textarea
            label={t('create.descriptionLabel')}
            autosize
            minRows={2}
            maxRows={6}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <div>
            <Text size="sm" fw={500} mb={4} id="new-process-start">
              {t('create.start')}
            </Text>
            <SegmentedControl
              aria-labelledby="new-process-start"
              value={start}
              onChange={(v) => {
                setStart(v as NewProcessStart);
                if (v === 'manual' && !name.trim()) setName(t('manualTemplate.name'));
              }}
              data={[
                { value: 'blank', label: t('create.blank') },
                { value: 'manual', label: t('create.manual') },
                { value: 'template', label: t('create.fromTemplate') },
              ]}
            />
            <Text size="xs" c="dimmed" mt={4}>
              {t(`create.startHint.${start}`)}
            </Text>
          </div>
          {start === 'template' && (
            <Select
              label={t('create.template')}
              withAsterisk
              searchable
              data={(templates.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={templateId}
              onChange={(v) => {
                setTemplateId(v);
                const found = templates.data?.find((x) => x.id === v);
                if (found && !name.trim()) setName(found.name);
              }}
              error={check.error('template')}
              description={tpl?.description}
              nothingFoundMessage={t('templates.noMatch')}
            />
          )}
          {isAdmin ? (
            <MultiSelect
              label={t('create.teams')}
              description={t('create.teamsHint')}
              placeholder={teamIds.length ? undefined : t('create.wholeInstance')}
              data={(teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={teamIds}
              onChange={setTeamIds}
              searchable
              clearable
            />
          ) : (
            <div>
              <Text size="sm" fw={500}>
                {t('create.teams')}
              </Text>
              <Text size="sm" c="dimmed">
                {mine.data?.teams.length ? t('create.yourTeams', { teams: mine.data.teams.map((x) => x.name).join(', ') }) : t('create.wholeInstanceText')}
              </Text>
            </div>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} leftSection={<IconPlus size={14} />}>
              {t('create.submit')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** A process of manual steps only, ready to fill in (the "Manual procedure" start), with its texts in the UI language. */
function manualDefinition(x: {
  instructions: string;
  prepare: string;
  prepareItems: string[];
  carryOut: string;
  carryOutItems: string[];
  ticket: string;
  check: string;
  checkItems: string[];
}): ProcessDefinition {
  const step = (id: string, pos: number, title: string, extra: Record<string, unknown>) => ({
    id,
    type: 'userTask',
    mode: 'manual',
    name: title,
    title,
    instructions: x.instructions,
    x: pos,
    y: 0,
    ...extra,
  });
  return {
    name: '',
    tags: ['manual'],
    connections: [],
    inputs: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', x: 0, y: 0 },
      step('prepare', 260, x.prepare, { checklist: x.prepareItems }),
      step('carryOut', 520, x.carryOut, {
        checklist: x.carryOutItems,
        fields: [{ id: 'ticket', type: 'ticket', label: x.ticket, use: 'required' }],
        verification: { required: true },
      }),
      step('check', 780, x.check, { checklist: x.checkItems, checklistAllRequired: true }),
    ],
    wires: [
      { from: 'start', port: 'out', to: 'prepare' },
      { from: 'prepare', port: 'out', to: 'carryOut' },
      { from: 'carryOut', port: 'out', to: 'check' },
    ],
  } as unknown as ProcessDefinition;
}
