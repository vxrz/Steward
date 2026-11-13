import { useState } from 'react';
import { ActionIcon, Button, Checkbox, Group, MultiSelect, Paper, SegmentedControl, Select, SimpleGrid, Stack, TagsInput, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CIA_COLORS,
  DATA_CLASSIFICATIONS,
  DATA_OBJECT_LIFECYCLES,
  DATA_PRODUCT_LIMITS as L,
  DATA_SUBJECT_SUGGESTIONS,
  DEFAULT_REGULATORY_FLAGS,
  LEGAL_BASES,
  PERSONAL_DATA_CATEGORIES,
  PERSONAL_DATA_LEVELS,
  SPECIAL_DATA_CATEGORIES,
  type CiaColor,
  type DataClassification,
  type DataDomain,
  type DataExternalRef,
  type DataObject,
  type DataObjectAttribute,
  type DataObjectInput,
  type DataObjectLifecycle,
  type LegalBasis,
  type PersonalDataLevel,
  type SpecialDataCategory,
} from '@sm/shared';
import { post, put } from '../../api';
import { FormModal } from '../FormModal';
import { SubjectsInput } from '../SubjectsInput';
import { useFieldErrors } from '../common';
import { domainOptions } from './ProductForm';
import { ExternalRefsInput, FormButtons, isHttpUrl, keyFromName, refsToSend, useBusy, validKey } from './form';

/**
 * Suggested values in the UI language, typed ones kept as they are: a TagsInput whose suggestions are fixed keys
 * (identification, customers …) shown translated – a chosen suggestion is stored as its key.
 */
function SuggestedTags({
  label,
  description,
  value,
  onChange,
  keys,
  text,
  max = L.listValues,
}: {
  label: string;
  description?: string;
  value: string[];
  onChange: (v: string[]) => void;
  keys: readonly string[];
  text: (k: string) => string;
  max?: number;
}) {
  const byLabel = new Map(keys.map((k) => [text(k).toLowerCase(), k]));
  return (
    <TagsInput
      label={label}
      description={description}
      data={keys.map((k) => text(k))}
      value={value.map((v) => (keys.includes(v) ? text(v) : v))}
      onChange={(vs) => onChange(vs.map((v) => byLabel.get(v.toLowerCase()) ?? v))}
      maxTags={max}
      clearable
    />
  );
}

/**
 * A data object (ADR 0036 part 2): what the data is – definition, synonyms, key attributes –, its classification,
 * personal data (categories, special categories, data subjects, legal basis, purposes, retention and deletion),
 * regulatory flags and the roles (data owner, stewards, custodians: responsibility, not rights). The CIA rating has its
 * own form (as on applications).
 */
export function ObjectForm({
  object,
  domains,
  onClose,
  onSaved,
}: {
  object?: DataObject;
  domains: DataDomain[] | undefined;
  onClose: () => void;
  onSaved: (o: DataObject) => void;
}) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const o = object;
  const [name, setName] = useState(o?.name ?? '');
  const [key, setKey] = useState(o?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!!o);
  const [definition, setDefinition] = useState(o?.definition ?? '');
  const [synonyms, setSynonyms] = useState<string[]>(o?.synonyms ?? []);
  const [domainId, setDomainId] = useState<string | null>(o?.domain && !o.domain.hidden ? o.domain.id : null);
  const [lifecycle, setLifecycle] = useState<DataObjectLifecycle>(o?.lifecycle ?? 'draft');
  const [classification, setClassification] = useState<DataClassification | null>(o?.classification ?? null);
  const [personal, setPersonal] = useState<PersonalDataLevel>(o?.personalData ?? 'none');
  const [categories, setCategories] = useState<string[]>(o?.categories ?? []);
  const [special, setSpecial] = useState<SpecialDataCategory[]>(o?.specialCategories ?? []);
  const [subjects, setSubjects] = useState<string[]>(o?.subjects ?? []);
  const [legalBasis, setLegalBasis] = useState<LegalBasis | null>(o?.legalBasis ?? null);
  const [legalNote, setLegalNote] = useState(o?.legalNote ?? '');
  const [purposes, setPurposes] = useState<string[]>(o?.purposes ?? []);
  const [retention, setRetention] = useState(o?.retention ?? '');
  const [deletionRule, setDeletionRule] = useState(o?.deletionRule ?? '');
  const [flags, setFlags] = useState<string[]>(o?.regulatoryFlags ?? []);
  const [attributes, setAttributes] = useState<DataObjectAttribute[]>(o?.attributes ?? []);
  const [owner, setOwner] = useState<string[]>(o?.owner ? [`user:${o.owner}`] : []);
  const [stewards, setStewards] = useState<string[]>(o?.stewards ?? []);
  const [custodians, setCustodians] = useState<string[]>(o?.custodians ?? []);
  const [refs, setRefs] = useState<DataExternalRef[]>(o?.externalRefs ?? []);
  const [busy, run] = useBusy();
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    key: !validKey(key) && t('form.keyInvalid'),
    owner: owner.some((x) => !x.startsWith('user:')) && t('objects.ownerUser'),
    refs: refsToSend(refs).some((r) => !isHttpUrl(r.url)) && t('form.refUrlInvalid'),
  });
  const save = () =>
    run(async () => {
      const body: DataObjectInput = {
        key: key.trim(),
        name: name.trim(),
        definition,
        synonyms,
        domainId,
        lifecycle,
        classification,
        personalData: personal,
        categories: personal === 'none' ? [] : categories,
        specialCategories: personal === 'special' ? special : [],
        subjects: personal === 'none' ? [] : subjects,
        legalBasis: personal === 'none' ? null : legalBasis,
        legalNote: personal === 'none' ? '' : legalNote,
        purposes,
        retention: retention.trim(),
        deletionRule,
        regulatoryFlags: flags,
        attributes: attributes.filter((a) => a.name.trim()).map((a) => ({ ...a, name: a.name.trim() })),
        owner: owner[0]?.replace(/^user:/, '') ?? null,
        stewards,
        custodians,
        externalRefs: refsToSend(refs),
      };
      onSaved(o ? await put<DataObject>(`/data-objects/${encodeURIComponent(o.id)}`, body) : await post<DataObject>('/data-objects', body));
    }, t('form.notSaved'));
  const setAttr = (i: number, patch: Partial<DataObjectAttribute>) => setAttributes(attributes.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  return (
    <FormModal onClose={onClose} size="xl" title={o ? t('objects.editTitle', { name: o.name }) : t('objects.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('form.name')}
              required
              maxLength={L.name}
              value={name}
              onChange={(e) => {
                const n = e.currentTarget.value;
                setName(n);
                if (!keyTouched) setKey(keyFromName(n));
              }}
              error={v.error('name')}
              data-autofocus
              data-testid="object-name"
            />
            <TextInput
              label={t('form.key')}
              description={t('form.keyHint')}
              required
              maxLength={L.key}
              value={key}
              onChange={(e) => {
                setKey(e.currentTarget.value);
                setKeyTouched(true);
              }}
              error={v.error('key')}
              className="mono"
            />
          </SimpleGrid>
          <Textarea label={t('objects.definition')} description={t('form.markdown')} autosize minRows={3} maxRows={10} maxLength={L.description} value={definition} onChange={(e) => setDefinition(e.currentTarget.value)} />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <Select label={t('form.domain')} data={domainOptions(domains)} value={domainId} onChange={setDomainId} clearable searchable placeholder={t('form.notSet')} />
            <Select
              label={t('objects.lifecycle')}
              data={DATA_OBJECT_LIFECYCLES.map((x) => ({ value: x, label: t(`lifecycle.${x}`) }))}
              value={lifecycle}
              onChange={(x) => x && setLifecycle(x as DataObjectLifecycle)}
              allowDeselect={false}
            />
            <Select
              label={t('rating.classification')}
              description={t('objects.classificationHint')}
              data={DATA_CLASSIFICATIONS.map((x) => ({ value: x, label: t(`classification.${x}`) }))}
              value={classification}
              onChange={(x) => setClassification(x as DataClassification | null)}
              clearable
              placeholder={t('form.notSet')}
              data-testid="object-classification"
            />
          </SimpleGrid>
          <TagsInput label={t('objects.synonyms')} value={synonyms} onChange={setSynonyms} maxTags={L.synonyms} clearable />
          <Paper withBorder p="sm">
            <Stack gap="xs">
              <Text size="sm" fw={600} id="object-personal-label">
                {t('objects.personalData')}
              </Text>
              <SegmentedControl
                aria-labelledby="object-personal-label"
                value={personal}
                onChange={(x) => setPersonal(x as PersonalDataLevel)}
                data={PERSONAL_DATA_LEVELS.map((x) => ({ value: x, label: t(`personalData.${x}`) }))}
                fullWidth
                data-testid="object-personal"
              />
              {personal !== 'none' && (
                <>
                  <SuggestedTags label={t('objects.categories')} value={categories} onChange={setCategories} keys={PERSONAL_DATA_CATEGORIES} text={(k) => t(`objects.categoryNames.${k as 'contact'}`)} />
                  {personal === 'special' && (
                    <MultiSelect
                      label={t('objects.special')}
                      description={t('objects.specialHint')}
                      data={SPECIAL_DATA_CATEGORIES.map((k) => ({ value: k, label: t(`objects.specialNames.${k}`) }))}
                      value={special}
                      onChange={(x) => setSpecial(x as SpecialDataCategory[])}
                      clearable
                    />
                  )}
                  <SuggestedTags label={t('objects.subjects')} value={subjects} onChange={setSubjects} keys={DATA_SUBJECT_SUGGESTIONS} text={(k) => t(`objects.subjectNames.${k as 'customers'}`)} />
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <Select
                      label={t('objects.legalBasis')}
                      data={LEGAL_BASES.map((k) => ({ value: k, label: t(`objects.legalBases.${k}`) }))}
                      value={legalBasis}
                      onChange={(x) => setLegalBasis(x as LegalBasis | null)}
                      clearable
                      placeholder={t('form.notSet')}
                    />
                    <TextInput label={t('objects.legalNote')} maxLength={L.text} value={legalNote} onChange={(e) => setLegalNote(e.currentTarget.value)} />
                  </SimpleGrid>
                </>
              )}
              <TagsInput label={t('objects.purposes')} value={purposes} onChange={setPurposes} maxTags={L.listValues} clearable />
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <TextInput label={t('objects.retention')} description={t('objects.retentionHint')} maxLength={L.short} value={retention} onChange={(e) => setRetention(e.currentTarget.value)} />
                <TextInput label={t('objects.deletionRule')} maxLength={L.text} value={deletionRule} onChange={(e) => setDeletionRule(e.currentTarget.value)} />
              </SimpleGrid>
            </Stack>
          </Paper>
          <TagsInput
            label={t('objects.flags')}
            description={t('objects.flagsHint')}
            data={[...DEFAULT_REGULATORY_FLAGS]}
            value={flags}
            onChange={setFlags}
            maxTags={L.listValues}
            clearable
          />
          <Paper withBorder p="sm">
            <Text size="sm" fw={600}>
              {t('objects.roles')}
            </Text>
            <Text size="xs" c="dimmed" mb="xs">
              {t('objects.rolesHint')}
            </Text>
            <Stack gap="xs">
              <SubjectsInput label={t('objects.owner')} description={t('objects.ownerHint')} value={owner} onChange={(x) => setOwner(x.slice(-1))} max={1} error={v.error('owner')} scope={{ kind: 'data_object', id: o?.id }} saved={o?.owner ? [`user:${o.owner}`] : []} />
              <SubjectsInput label={t('objects.stewards')} value={stewards} onChange={setStewards} max={L.subjects} scope={{ kind: 'data_object', id: o?.id }} saved={o?.stewards} />
              <SubjectsInput label={t('objects.custodians')} description={t('objects.custodiansHint')} value={custodians} onChange={setCustodians} max={L.subjects} />
            </Stack>
          </Paper>
          <Stack gap={6}>
            <Text size="sm" fw={500}>
              {t('objects.attributes')}
            </Text>
            <Text size="xs" c="dimmed" mt={-4}>
              {t('objects.attributesHint')}
            </Text>
            {attributes.map((a, i) => (
              <Group key={i} gap="xs" wrap="wrap" align="flex-start">
                <TextInput size="xs" aria-label={t('objects.attributeName')} placeholder={t('objects.attributeName')} maxLength={L.name} value={a.name} onChange={(e) => setAttr(i, { name: e.currentTarget.value })} style={{ flex: '1 1 140px' }} />
                <TextInput
                  size="xs"
                  aria-label={t('objects.attributeDescription')}
                  placeholder={t('objects.attributeDescription')}
                  maxLength={L.text}
                  value={a.description}
                  onChange={(e) => setAttr(i, { description: e.currentTarget.value })}
                  style={{ flex: '2 1 200px' }}
                />
                <Checkbox size="xs" mt={6} label={t('objects.attributePersonal')} checked={a.personal} onChange={(e) => setAttr(i, { personal: e.currentTarget.checked })} />
                <Tooltip label={t('objects.attributeRemove')}>
                  <ActionIcon variant="subtle" color="red" aria-label={t('objects.attributeRemove')} onClick={() => setAttributes(attributes.filter((_, j) => j !== i))} mt={2}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ))}
            {attributes.length < L.attributes && (
              <Group>
                <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setAttributes([...attributes, { name: '', description: '', personal: false }])}>
                  {t('objects.attributeAdd')}
                </Button>
              </Group>
            )}
          </Stack>
          <ExternalRefsInput value={refs} onChange={setRefs} error={!!v.error('refs')} />
          <FormButtons busy={busy} submit={o ? undefined : t('objects.create')} testId="object-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** A domain or sub-domain (two levels): key, name, description, its parent, a colour and owners. */
export function DomainForm({ domain, domains, onClose, onSaved }: { domain?: DataDomain; domains: DataDomain[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProducts', 'applications', 'common']);
  const d = domain;
  const [name, setName] = useState(d?.name ?? '');
  const [key, setKey] = useState(d?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(!!d);
  const [description, setDescription] = useState(d?.description ?? '');
  const [parentId, setParentId] = useState<string | null>(d?.parentId ?? null);
  const [colour, setColour] = useState<CiaColor | null>(d?.colour ?? null);
  const [owners, setOwners] = useState<string[]>(d?.owners ?? []);
  const [busy, run] = useBusy();
  const hasChildren = !!d && domains.some((x) => x.parentId === d.id);
  const v = useFieldErrors({ name: !name.trim() && t('common:validation.required'), key: !validKey(key) && t('form.keyInvalid') });
  const save = () =>
    run(async () => {
      const body = { key: key.trim(), name: name.trim(), description, parentId, colour, owners };
      if (d) await put(`/data-domains/${encodeURIComponent(d.id)}`, body);
      else await post('/data-domains', body);
      onSaved();
    }, t('form.notSaved'));
  return (
    <FormModal onClose={onClose} title={d ? t('domains.editTitle', { name: d.name }) : t('domains.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('form.name')}
              required
              maxLength={L.name}
              value={name}
              onChange={(e) => {
                const n = e.currentTarget.value;
                setName(n);
                if (!keyTouched) setKey(keyFromName(n));
              }}
              error={v.error('name')}
              data-autofocus
              data-testid="domain-name"
            />
            <TextInput
              label={t('form.key')}
              required
              maxLength={L.key}
              value={key}
              onChange={(e) => {
                setKey(e.currentTarget.value);
                setKeyTouched(true);
              }}
              error={v.error('key')}
              className="mono"
            />
          </SimpleGrid>
          <Select
            label={t('domains.parent')}
            description={hasChildren ? t('domains.parentLocked') : t('domains.parentHint')}
            data={domains.filter((x) => !x.parentId && x.id !== d?.id).map((x) => ({ value: x.id, label: x.name }))}
            value={parentId}
            onChange={setParentId}
            clearable
            disabled={hasChildren}
            placeholder={t('domains.topLevel')}
          />
          <Textarea label={t('form.description')} autosize minRows={2} maxLength={L.description} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
          <Select
            label={t('domains.colour')}
            data={CIA_COLORS.map((c) => ({ value: c, label: t(`applications:scale.colors.${c}`) }))}
            value={colour}
            onChange={(c) => setColour(c as CiaColor | null)}
            clearable
            placeholder={t('form.notSet')}
            renderOption={({ option }) => (
              <Group gap="xs">
                <ColorSwatchDot colour={option.value as CiaColor} />
                {option.label}
              </Group>
            )}
          />
          <SubjectsInput label={t('domains.owners')} description={t('domains.ownersHint')} value={owners} onChange={setOwners} max={L.subjects} scope={{ kind: 'data_domain', id: d?.id }} saved={d?.owners} />
          <FormButtons busy={busy} testId="domain-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

export function ColorSwatchDot({ colour }: { colour: CiaColor }) {
  return <span aria-hidden style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: `var(--mantine-color-${colour}-6)` }} />;
}
