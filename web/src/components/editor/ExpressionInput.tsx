import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Anchor, Badge, Box, Group, Loader, Popover, ScrollArea, Stack, Text, Textarea, Tooltip, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { EvaluateResult } from '@sm/shared';
import { JsonView } from '../common';
import { useExprContext } from './ExprContext';
import { compactJson, filterSuggestions, tokenAt, type Suggestion } from './exprAssist';
import { evaluateExpression, isNotFound } from './editorApi';

const KIND_COLOR: Record<Suggestion['kind'], string> = {
  input: 'blue',
  const: 'teal',
  var: 'grape',
  conn: 'orange',
  run: 'gray',
  loop: 'indigo',
  item: 'indigo',
  fn: 'cyan',
  root: 'gray',
};
// Kind badges mirror the expression roots (inputs., const., vars. …), so they stay as written in expressions.
const KIND_LABEL: Record<Suggestion['kind'], string> = {
  input: 'input',
  const: 'const',
  var: 'var',
  conn: 'conn',
  run: 'run',
  loop: 'loop',
  item: 'item',
  fn: 'fn',
  root: '',
};

export interface ExpressionInputProps {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  /** Template: suggestions only inside {{ }} */
  template?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  placeholder?: string;
  error?: ReactNode;
  size?: 'xs' | 'sm';
  minRows?: number;
  maxRows?: number;
  /** Show the live preview (default true) */
  preview?: boolean;
  'aria-label'?: string;
  style?: React.CSSProperties;
}

/** Textarea with autocomplete for expressions/templates and a live preview evaluated against the latest run. */
export function ExpressionInput({
  value,
  onChange,
  onBlur,
  template = false,
  label,
  description,
  placeholder,
  error,
  size = 'sm',
  minRows = 1,
  maxRows = 10,
  preview = true,
  style,
  ...rest
}: ExpressionInputProps) {
  const { t } = useTranslation('editor');
  const ctx = useExprContext();
  const ref = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [tok, setTok] = useState<{ start: number; caret: number } | null>(null);
  const [touched, setTouched] = useState(false);
  const open = ctx.enabled && items.length > 0 && !!tok;

  const refresh = (text: string, caret: number, force = false) => {
    if (!ctx.enabled) return;
    const t = tokenAt(text, caret, template);
    if (!t) {
      setItems([]);
      setTok(null);
      return;
    }
    const list = filterSuggestions(
      ctx.suggestions,
      t.token,
      t.exprStart && (force || text.slice(t.start - 2, t.start).endsWith('{{') || text.slice(t.start - 3, t.start).endsWith('{{ ')),
      force,
    );
    setItems(list);
    setActive(0);
    setTok({ start: t.start, caret });
  };
  const close = () => {
    setItems([]);
    setTok(null);
  };

  const accept = (s: Suggestion) => {
    if (!tok) return;
    const next = value.slice(0, tok.start) + s.insert + value.slice(tok.caret);
    const pos = tok.start + s.insert.length;
    onChange(next);
    close();
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      // continue completing after a root ("vars.") or a variable with known fields
      if (s.kind === 'root' || s.insert.endsWith('.')) refresh(next, pos, true);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      e.preventDefault();
      refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? 0, true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      accept(items[active]!);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  // keep the active option visible
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  const activeItem = open ? items[active] : undefined;

  return (
    <Stack gap={2} style={style}>
      <Popover
        opened={open}
        position="bottom-start"
        width="target"
        withinPortal
        trapFocus={false}
        returnFocus={false}
        closeOnEscape={false}
        onClose={close}
        zIndex={1000}
        middlewares={{ flip: true, shift: true }}
        shadow="md"
      >
        <Popover.Target>
          <Textarea
            ref={ref}
            label={label}
            description={description}
            placeholder={placeholder}
            error={error}
            size={size}
            autosize
            minRows={minRows}
            maxRows={maxRows}
            spellCheck={false}
            classNames={{ input: 'mono' }}
            value={value}
            aria-label={rest['aria-label']}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={open ? `${listId}-${active}` : undefined}
            onChange={(e) => {
              onChange(e.currentTarget.value);
              refresh(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length);
            }}
            onKeyDown={onKeyDown}
            onClick={close}
            onFocus={() => setTouched(true)}
            onBlur={() => {
              close();
              onBlur?.();
            }}
          />
        </Popover.Target>
        <Popover.Dropdown p={4} onMouseDown={(e) => e.preventDefault()} style={{ minWidth: 'min(300px, calc(100vw - 16px))' }}>
          <ScrollArea.Autosize mah={240} type="auto">
            <Box role="listbox" id={listId} aria-label={t('expr.suggestions')}>
              {items.map((s, i) => (
                <UnstyledButton
                  key={s.insert}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => accept(s)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '3px 6px',
                    borderRadius: 4,
                    background: i === active ? 'var(--mantine-color-blue-light)' : undefined,
                  }}
                >
                  <Group gap={6} wrap="nowrap">
                    {KIND_LABEL[s.kind] && (
                      <Badge size="xs" variant="light" color={KIND_COLOR[s.kind]} w={44} style={{ flexShrink: 0 }}>
                        {KIND_LABEL[s.kind]}
                      </Badge>
                    )}
                    <Text size="xs" className="mono" truncate style={{ flexShrink: 1, minWidth: 0 }}>
                      {s.label}
                    </Text>
                    {s.detail && (
                      <Text size="10px" c="dimmed" truncate style={{ flex: 1, minWidth: 0, textAlign: 'right' }}>
                        {s.detail}
                      </Text>
                    )}
                  </Group>
                </UnstyledButton>
              ))}
            </Box>
          </ScrollArea.Autosize>
          <Box px={6} pt={4} mt={2} style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
            {activeItem?.help ? (
              <Text size="10px">
                <span className="mono">{activeItem.detail}</span> – {activeItem.help}
              </Text>
            ) : (
              <Text size="10px" c="dimmed">
                {t('expr.keys')}
              </Text>
            )}
          </Box>
        </Popover.Dropdown>
      </Popover>
      {preview && touched && <ExprPreview expression={value} template={template} />}
    </Stack>
  );
}

/** Debounced evaluation of the expression against the latest run (at the current node). */
export function ExprPreview({ expression, template }: { expression: string; template: boolean }) {
  const { t } = useTranslation('editor');
  const { processId, nodeId } = useExprContext();
  const [state, setState] = useState<{ loading: boolean; result?: EvaluateResult; failure?: string; unsupported?: boolean }>({ loading: false });
  const [expanded, setExpanded] = useState(false);
  const seq = useRef(0);
  const blank = !expression.trim() || (template && !expression.includes('{{'));

  useEffect(() => {
    if (!processId || blank) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      evaluateExpression(processId, { expression, template, nodeId })
        .then((result) => mine === seq.current && setState({ loading: false, result }))
        .catch((e) => mine === seq.current && setState({ loading: false, failure: (e as Error).message, unsupported: isNotFound(e) }));
    }, 400);
    return () => clearTimeout(timer);
  }, [processId, expression, template, nodeId, blank]);

  if (!processId) {
    return (
      <Text size="10px" c="dimmed">
        {t('expr.saveToPreview')}
      </Text>
    );
  }
  if (blank) return null;
  if (state.unsupported) {
    return (
      <Text size="10px" c="dimmed">
        {t('expr.previewUnavailable')}
      </Text>
    );
  }
  const r = state.result;
  const compact = r?.ok ? compactJson(r.value) : null;
  const expandable = !!r?.ok && (compact!.truncated || (typeof r.value === 'object' && r.value !== null));
  return (
    <Box
      px={6}
      py={3}
      style={{ borderRadius: 4, background: 'var(--mantine-color-default-hover)', opacity: state.loading ? 0.7 : 1 }}
      aria-live="polite"
      data-testid="expr-preview"
    >
      <Group gap={4} wrap="nowrap" align="flex-start">
        {state.loading && !r && !state.failure ? (
          <Group gap={4}>
            <Loader size={10} />
            <Text size="10px" c="dimmed">
              {t('expr.evaluating')}
            </Text>
          </Group>
        ) : state.failure ? (
          <Text size="xs" c="red" style={{ wordBreak: 'break-word', flex: 1 }}>
            {t('expr.previewFailed', { error: state.failure })}
          </Text>
        ) : r && !r.ok ? (
          <Text size="xs" c="red" className="mono" style={{ wordBreak: 'break-word', flex: 1 }}>
            {r.error ?? t('expr.error')}
          </Text>
        ) : r ? (
          <Text size="xs" className="mono" style={{ wordBreak: 'break-all', flex: 1, minWidth: 0 }}>
            <Text span c="dimmed" size="xs">
              ={' '}
            </Text>
            {compact!.text}
          </Text>
        ) : null}
        {state.loading && r && <Loader size={10} />}
        {expandable && (
          <Tooltip label={expanded ? t('expr.collapse') : t('expr.showFull')}>
            <ActionIcon size="xs" variant="subtle" onClick={() => setExpanded((x) => !x)} aria-label={expanded ? t('expr.collapseValue') : t('expr.showFull')}>
              {expanded ? <IconChevronUp size={12} /> : <IconChevronDown size={12} />}
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      {expanded && r?.ok && (
        <Box mt={4}>
          <JsonView value={r.value} maxHeight={260} />
        </Box>
      )}
      {(r || state.failure) && (
        <Text size="10px" c="dimmed" mt={2}>
          {r?.runId ? (
            <Trans
              t={t}
              i18nKey="expr.usingRun"
              values={{ id: r.runId }}
              components={{ a: <Anchor href={`/runs/${r.runId}`} target="_blank" size="10px" className="mono" /> }}
            />
          ) : r ? (
            t('expr.noRun')
          ) : null}
        </Text>
      )}
    </Box>
  );
}
