import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Button, Code, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { reportError } from '../errorReporting';
import i18n from '../i18n';

interface Props {
  children: ReactNode;
  /** Changing this value (e.g. the current path) clears the error, so navigating away recovers. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  resetKey?: string;
}

/** Catches rendering errors: shows a friendly message instead of a blank page and reports the error (if configured). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(error, info.componentStack ?? undefined);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // i18n.t (not the hook): this class component may render before React's i18n context exists.
    const t = i18n.t.bind(i18n);
    return (
      <Stack p="md" maw={720}>
        <Alert color="red" variant="light" icon={<IconAlertTriangle />} title={t('errors:boundary.title')}>
          <Stack gap="sm">
            <Text size="sm">
              {t('errors:boundary.text')}
            </Text>
            <Code block>{error.message || String(error)}</Code>
            <Group gap="sm">
              <Button size="xs" variant="light" onClick={() => this.setState({ error: null })}>
                {t('errors:boundary.retry')}
              </Button>
              <Button size="xs" variant="default" onClick={() => window.location.reload()}>
                {t('errors:boundary.reload')}
              </Button>
            </Group>
          </Stack>
        </Alert>
      </Stack>
    );
  }
}
