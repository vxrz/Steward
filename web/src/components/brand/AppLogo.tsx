import { useState } from 'react';
import { useAppTheme } from '../../theme';
import { Logo } from './Logo';

/**
 * The header/sign-in logo: the administrator's logo (Settings → Appearance) or the
 * Steward mark. Wide logos may take up to four times their height.
 * `title` makes it an image with that name; without it the logo is decorative
 * (the name is next to it).
 */
export function AppLogo({ size = 28, title }: { size?: number; title?: string }) {
  const { logoUrl } = useAppTheme();
  const [failed, setFailed] = useState<string | null>(null);
  if (!logoUrl || failed === logoUrl) return <Logo size={size} title={title} />;
  return (
    <img
      src={logoUrl}
      alt={title ?? ''}
      height={size}
      onError={() => setFailed(logoUrl)}
      style={{ height: size, width: 'auto', maxWidth: size * 4, objectFit: 'contain', flexShrink: 0, display: 'block' }}
    />
  );
}
