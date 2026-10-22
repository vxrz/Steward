import { Select, type SelectProps } from '@mantine/core';
import { IconLanguage } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { currentLanguage } from '../i18n';
import { LANGUAGES, isLocale } from '../i18n/languages';
import { useChangeLanguage } from './LanguageSwitcher';

/** Language picker for the profile page (native language names, so everyone finds their own). */
export function LanguageSelect(props: Omit<SelectProps, 'data' | 'value' | 'onChange'>) {
  const { t, i18n } = useTranslation('nav');
  const change = useChangeLanguage();
  return (
    <Select
      label={t('language')}
      leftSection={<IconLanguage size={16} />}
      allowDeselect={false}
      comboboxProps={{ withinPortal: true }}
      {...props}
      data={LANGUAGES.map((l) => ({ value: l.code, label: l.nativeName }))}
      // i18n.language keeps this in sync when the language changes elsewhere
      value={i18n.language ? currentLanguage() : null}
      onChange={(v) => isLocale(v) && void change(v)}
    />
  );
}
