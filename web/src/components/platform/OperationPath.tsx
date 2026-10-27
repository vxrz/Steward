import { Text } from '@mantine/core';
import type { ApiOperation } from '@sm/shared';

/** An operation's effective path: the spec's path prefix (dimmed) followed by the path of the specification. */
export function OperationPath({ op }: { op: ApiOperation }) {
  const prefix = op.specPath && op.path.endsWith(op.specPath) ? op.path.slice(0, op.path.length - op.specPath.length) : '';
  if (!prefix) return <>{op.path}</>;
  return (
    <>
      <Text span inherit c="dimmed">
        {prefix}
      </Text>
      {op.specPath}
    </>
  );
}
