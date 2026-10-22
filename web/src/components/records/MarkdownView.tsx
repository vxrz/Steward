import { Fragment, useMemo, type ReactNode } from 'react';
import { Anchor, Blockquote, Box, Checkbox, Code, Divider, List, Table, Text, Title } from '@mantine/core';
import { parseMarkdown, type MdBlock, type MdInline } from '@sm/shared';

/**
 * Renders Markdown safely: the shared parser builds a syntax tree and this
 * component turns it into React elements. Raw HTML in the text is never
 * interpreted (it shows as text), links are http(s)/mailto only and open in a
 * new tab without a referrer.
 */
export function MarkdownView({ text, compact }: { text: string; compact?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <Box className="md-view" fz={compact ? 'sm' : undefined}>
      {renderBlocks(blocks, 'b')}
    </Box>
  );
}

function inline(nodes: MdInline[], key: string): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'code':
        return <Code key={k}>{n.v}</Code>;
      case 'strong':
        return <strong key={k}>{inline(n.c, k)}</strong>;
      case 'em':
        return <em key={k}>{inline(n.c, k)}</em>;
      case 'del':
        return <del key={k}>{inline(n.c, k)}</del>;
      case 'br':
        return <br key={k} />;
      case 'link':
        return (
          <Anchor key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">
            {inline(n.c, k)}
          </Anchor>
        );
    }
  });
}

function renderBlocks(blocks: MdBlock[], key: string): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case 'heading':
        // Record pages already use h2 for the page title: content headings start at h3.
        return (
          <Title key={k} order={Math.min(6, b.level + 2) as 3} mt="md" mb={6} fz={b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5'}>
            {inline(b.c, k)}
          </Title>
        );
      case 'paragraph':
        return (
          <Text key={k} mb="xs" size="sm" style={{ overflowWrap: 'anywhere' }}>
            {inline(b.c, k)}
          </Text>
        );
      case 'code':
        return (
          <Code key={k} block mb="xs" style={{ whiteSpace: 'pre', overflowX: 'auto' }}>
            {b.v}
          </Code>
        );
      case 'quote':
        return (
          <Blockquote key={k} p="xs" pl="md" mb="xs" color="gray">
            {renderBlocks(b.blocks, k)}
          </Blockquote>
        );
      case 'list':
        return (
          <List key={k} type={b.ordered ? 'ordered' : 'unordered'} start={b.ordered ? b.start : undefined} size="sm" mb="xs" withPadding>
            {b.items.map((it, j) => (
              <List.Item
                key={`${k}.${j}`}
                icon={
                  it.checked === undefined ? undefined : <Checkbox size="xs" checked={it.checked} readOnly tabIndex={-1} aria-label={it.checked ? '✓' : '–'} />
                }
              >
                {it.blocks.length === 1 && it.blocks[0]!.t === 'paragraph' ? inline(it.blocks[0]!.c, `${k}.${j}`) : renderBlocks(it.blocks, `${k}.${j}`)}
              </List.Item>
            ))}
          </List>
        );
      case 'table':
        return (
          <Box key={k} className="table-scroll" mb="xs">
            <Table withTableBorder withColumnBorders fz="sm">
              <Table.Thead>
                <Table.Tr>
                  {b.head.map((h, j) => (
                    <Table.Th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                      {inline(h, `${k}.h${j}`)}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {b.rows.map((r, ri) => (
                  <Table.Tr key={ri}>
                    {r.map((c, j) => (
                      <Table.Td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
                        {inline(c, `${k}.${ri}.${j}`)}
                      </Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        );
      case 'hr':
        return <Divider key={k} my="sm" />;
    }
  });
}
