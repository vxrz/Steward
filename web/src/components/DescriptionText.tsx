import type { ReactNode } from 'react';
import { Text, type TextProps } from '@mantine/core';
import { parseInline, type MdInline } from '@sm/shared';

/**
 * A description as running text: lines wrapped in the source are joined (paragraphs too), so the preview does not
 * break mid-sentence, and the inline Markdown subset – bold, italics, code, strikethrough – is rendered instead of
 * shown as `**` and backticks. Links render as their text (the preview usually sits inside a clickable card).
 */
export function flattenDescription(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split('\n')
        .map((l) => l.trim().replace(/^[-*]\s+/, '– '))
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .join(' ');
}

function render(nodes: MdInline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'code':
        return (
          <code key={i} className="inline-code">
            {n.v}
          </code>
        );
      case 'strong':
        return <strong key={i}>{render(n.c)}</strong>;
      case 'em':
        return <em key={i}>{render(n.c)}</em>;
      case 'del':
        return <s key={i}>{render(n.c)}</s>;
      case 'link':
        return <span key={i}>{render(n.c)}</span>;
      case 'br':
        return ' ';
    }
  });
}

/** Plain text of a description (search, titles, aria). */
export const descriptionPlain = (text: string): string => flattenDescription(text).replace(/\*\*|__|`/g, '');

export function DescriptionText({ text, ...props }: { text: string | null | undefined } & TextProps) {
  if (!text) return null;
  return <Text {...props}>{render(parseInline(flattenDescription(text)))}</Text>;
}
