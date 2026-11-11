import { useMemo } from 'react';
import { Avatar, Group, MultiSelect, TagsInput, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Subject } from '@sm/shared';
import { getOptional } from '../api';
import { subjectKeys } from '../queryKeys';
import { subjectOptionLabel } from './AccessEditor';
import { subjectLabel } from './common';

const useSubjects = () => useQuery({ queryKey: subjectKeys.all, queryFn: () => getOptional<Subject[]>('/subjects', []), retry: false, staleTime: 60_000 });

/**
 * Owners and other subjects by name: users by their display name ("Dana Designer", not "dana"), teams as they were
 * entered ("Team Service Desk", while the stored value is lower-case). Without the list (read-only accounts) or for a
 * subject that is not on it any more, as stored (`subjectLabel`).
 */
export function useSubjectLabel(): (subject: string) => string {
  const { t } = useTranslation('common');
  const subjects = useSubjects();
  // `t`: recompute when the language changes (the labels are translated with the global i18n instance)
  return useMemo(() => {
    const known = new Map((subjects.data ?? []).map((s) => [s.value, s]));
    return (subject: string) => {
      const s = known.get(subject.toLowerCase());
      if (!s) return subjectLabel(subject);
      if (s.kind === 'user') return s.label.replace(/\s*\([^()]*\)$/, '') || subjectLabel(subject);
      return subjectOptionLabel(s);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjects.data, t]);
}

/**
 * Owners and other people (#143): users and teams picked from the list (with roles where `roles` is set), so a typo
 * cannot become an owner nobody is. Values that are not on the list any more (a deactivated account, a deleted team)
 * stay visible and can be removed. Without the list (no right to read it) the field takes user:/team: text.
 */
export function SubjectsInput({
  label,
  description,
  value,
  onChange,
  max = 20,
  roles = false,
  error,
}: {
  label: string;
  description?: string;
  value: string[];
  onChange: (v: string[]) => void;
  max?: number;
  roles?: boolean;
  error?: string;
}) {
  const { t } = useTranslation('common');
  const subjects = useSubjects();
  const list = useMemo(() => (subjects.data ?? []).filter((s) => roles || s.kind !== 'role'), [subjects.data, roles]);
  const known = useMemo(() => new Map(list.map((s) => [s.value, s])), [list]);
  if (subjects.isSuccess && list.length === 0)
    return <TagsInput label={label} description={description} value={value} onChange={onChange} maxTags={max} error={error} />;
  const groups = (['user', 'team', 'role'] as const)
    .map((kind) => ({
      group: t(`subjects.groups.${kind}`),
      items: list.filter((s) => s.kind === kind).map((s) => ({ value: s.value, label: subjectOptionLabel(s) })),
    }))
    .filter((g) => g.items.length);
  const unknown = value.filter((v) => !known.has(v)).map((v) => ({ value: v, label: t('subjects.unknown', { name: v.replace(/^(user|team):/, '') }) }));
  return (
    <MultiSelect
      label={label}
      description={description}
      data={[...groups, ...(unknown.length ? [{ group: t('subjects.groups.unknown'), items: unknown }] : [])]}
      value={value}
      onChange={onChange}
      maxValues={max}
      searchable
      clearable
      error={error}
      nothingFoundMessage={t('subjects.nothingFound')}
      placeholder={value.length ? undefined : t('subjects.placeholder')}
      renderOption={({ option }) => {
        const s = known.get(option.value);
        return (
          <Group gap="xs" wrap="nowrap">
            <Avatar size={22} radius="xl" name={s?.kind === 'user' ? (s.label.replace(/\s*\(.*\)$/, '') ?? option.label) : option.label} color="initials" />
            <Text size="sm" c={s ? undefined : 'orange'}>
              {option.label}
            </Text>
          </Group>
        );
      }}
      data-testid="subjects-input"
    />
  );
}
