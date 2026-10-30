import { useRef, useState } from 'react';
import { ActionIcon, Autocomplete, Badge, CloseButton, Group, Input, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { normalizeTag, splitTag, tagLabel, tagProblem } from '@sm/shared';

/**
 * Tags with an optional value (#143): `pci` or `env=prod`, shown as `env: prod`. The input takes a key; Tab moves to
 * the optional value, Enter adds the tag. Keys and values are suggested from the tags in use.
 */
export function TagInput({
  label,
  description,
  value,
  onChange,
  suggestions = [],
  max = 30,
  lower,
}: {
  label: string;
  description?: string;
  value: string[];
  onChange: (tags: string[]) => void;
  /** Tags in use elsewhere (for the key and value suggestions) */
  suggestions?: string[];
  max?: number;
  /** Stored in lower case (applications, services, records) */
  lower?: boolean;
}) {
  const { t } = useTranslation('common');
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const parsed = suggestions.map(splitTag);
  const keys = [...new Set(parsed.map((p) => p.key))].sort();
  const values = [...new Set(parsed.filter((p) => p.key === key.trim() && p.value).map((p) => p.value!))].sort();
  const add = () => {
    if (!key.trim()) return;
    // "env=prod" or "env: prod" typed into the key field works too
    const raw = val.trim() ? `${key.trim()}=${val.trim()}` : key;
    let tag = normalizeTag(raw);
    if (lower) tag = tag.toLowerCase();
    const problem = tagProblem(tag);
    if (problem) {
      setError(t(`tags.problem.${problem}`));
      return;
    }
    if (value.length >= max) {
      setError(t('tags.tooMany', { max }));
      return;
    }
    // one value per key: a new value replaces the old one (like labels)
    const next = splitTag(tag);
    const replaced = (x: string) => next.value !== null && splitTag(x).key === next.key && splitTag(x).value !== null;
    onChange([...value.filter((x) => x !== tag && !replaced(x)), tag]);
    setKey('');
    setVal('');
    setError(null);
    keyRef.current?.focus();
  };
  const onEnter = (e: React.KeyboardEvent) => {
    // Enter on a highlighted suggestion picks it (the dropdown handles that)
    if (e.key === 'Enter' && !e.defaultPrevented && !e.nativeEvent.isComposing) {
      e.preventDefault();
      add();
    }
  };
  return (
    <Input.Wrapper label={label} description={description ?? t('tags.hint')} error={error}>
      <Stack gap={6} mt={4}>
        {value.length > 0 && (
          <Group gap={4} role="list" aria-label={label}>
            {value.map((tag) => (
              <Badge
                key={tag}
                role="listitem"
                variant="light"
                color="gray"
                rightSection={
                  <CloseButton size="xs" aria-label={t('tags.remove', { tag: tagLabel(tag) })} onClick={() => onChange(value.filter((x) => x !== tag))} />
                }
              >
                {tagLabel(tag)}
              </Badge>
            ))}
          </Group>
        )}
        <Group gap="xs" wrap="nowrap" align="flex-end">
          <Autocomplete
            ref={keyRef}
            size="xs"
            style={{ flex: 1 }}
            aria-label={t('tags.key')}
            placeholder={t('tags.keyPlaceholder')}
            data={keys}
            value={key}
            onChange={(v) => {
              setKey(v);
              setError(null);
            }}
            onKeyDown={onEnter}
          />
          <Autocomplete
            size="xs"
            style={{ flex: 1 }}
            aria-label={t('tags.value')}
            placeholder={t('tags.valuePlaceholder')}
            data={values}
            value={val}
            onChange={(v) => {
              setVal(v);
              setError(null);
            }}
            onKeyDown={onEnter}
          />
          <ActionIcon variant="light" size="input-xs" aria-label={t('tags.add')} onClick={add} disabled={!key.trim()}>
            <IconPlus size={14} />
          </ActionIcon>
        </Group>
      </Stack>
    </Input.Wrapper>
  );
}

/** Tags as badges; with `onTag` each one filters the list by it, with `linkTo` it links to the filtered list. */
export function TagBadges({
  tags,
  onTag,
  linkTo,
  size = 'xs',
}: {
  tags: string[];
  onTag?: (tag: string) => void;
  linkTo?: (tag: string) => string;
  size?: 'xs' | 'sm';
}) {
  const { t } = useTranslation('common');
  if (!tags.length) return null;
  return (
    <Group gap={4}>
      {tags.map((tag) =>
        linkTo ? (
          <Badge
            key={tag}
            size={size}
            variant="default"
            component={Link}
            to={linkTo(tag)}
            style={{ cursor: 'pointer' }}
            aria-label={t('tags.filterBy', { tag: tagLabel(tag) })}
          >
            {tagLabel(tag)}
          </Badge>
        ) : onTag ? (
          <UnstyledButton
            key={tag}
            onClick={(e) => {
              e.stopPropagation();
              onTag(tag);
            }}
            aria-label={t('tags.filterBy', { tag: tagLabel(tag) })}
          >
            <Badge size={size} variant="default" style={{ cursor: 'pointer' }}>
              {tagLabel(tag)}
            </Badge>
          </UnstyledButton>
        ) : (
          <Badge key={tag} size={size} variant="default">
            {tagLabel(tag)}
          </Badge>
        ),
      )}
    </Group>
  );
}

/** The tag filter of a list, kept in the URL (`?tag=env=prod` or `?tag=env`). */
export function useTagFilter(): [string | null, (tag: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const tag = params.get('tag');
  const set = (next: string | null) => {
    const p = new URLSearchParams(params);
    if (next) p.set('tag', next);
    else p.delete('tag');
    setParams(p, { replace: true });
  };
  return [tag, set];
}

/** The active tag filter: clear it, or widen `env=prod` to every value of `env`. */
export function TagFilterChip({ tag, onChange }: { tag: string | null; onChange: (tag: string | null) => void }) {
  const { t } = useTranslation('common');
  if (!tag) return null;
  const { key, value } = splitTag(tag);
  return (
    <Group gap={6} data-testid="tag-filter">
      <Badge
        variant="light"
        rightSection={
          <ActionIcon size="xs" variant="transparent" aria-label={t('tags.clear', { tag: tagLabel(tag) })} onClick={() => onChange(null)}>
            <IconX size={12} />
          </ActionIcon>
        }
      >
        {t('tags.filtered', { tag: tagLabel(tag) })}
      </Badge>
      {value && (
        <UnstyledButton onClick={() => onChange(key)}>
          <Text size="xs" c="dimmed" td="underline">
            {t('tags.anyValue', { key })}
          </Text>
        </UnstyledButton>
      )}
    </Group>
  );
}
