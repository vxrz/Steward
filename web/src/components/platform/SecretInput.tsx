import { useEffect, useRef, useState, type ReactNode } from 'react';
import { PasswordInput, Textarea } from '@mantine/core';
import { useTranslation } from 'react-i18next';

/**
 * The value of a platform credential (0.26.2). A password field drops the line breaks of pasted text – a PEM key
 * pasted there could not be read – so a credential that holds the text of a file (`multiline`: a PEM key or
 * certificate) is a monospace text area, and so is the field once a PEM block is pasted into it. The value is only
 * ever typed or pasted here: stored credentials are never sent back to the browser.
 */
export function SecretInput({
  label,
  description,
  value,
  onChange,
  multiline = false,
  testId,
}: {
  label: ReactNode;
  description?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation('platforms');
  // once multi-line, it stays so (emptying the field does not switch it back under the cursor)
  const [stay, setStay] = useState(multiline);
  const [focusArea, setFocusArea] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (multiline) setStay(true);
  }, [multiline]);
  useEffect(() => {
    // a PEM pasted into the password field: the text area takes its place, the cursor goes with it
    if (focusArea && area.current) {
      area.current.focus();
      setFocusArea(false);
    }
  }, [focusArea, stay]);

  if (multiline || stay) {
    return (
      <Textarea
        ref={area}
        label={label}
        description={
          <>
            {description}
            {description ? ' ' : null}
            {t('credentials.pemHint')}
          </>
        }
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        autosize
        minRows={4}
        maxRows={14}
        classNames={{ input: 'mono' }}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        data-testid={testId}
      />
    );
  }
  return (
    <PasswordInput
      label={label}
      description={description}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      onPaste={(e) => {
        const text = e.clipboardData.getData('text');
        if (!text.includes('-----BEGIN ')) return;
        // keep the line breaks the password field would drop
        e.preventDefault();
        onChange(text);
        setStay(true);
        setFocusArea(true);
      }}
      // a secret for the platform: the browser must not fill in the password saved for Steward
      autoComplete="new-password"
      data-testid={testId}
    />
  );
}
