import { useId } from 'react';

/** The Steward mark: a flow drawn as an "S" that ends in a check. */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} style={{ flexShrink: 0, display: 'block' }}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#339af0" />
          <stop offset="1" stopColor="#1864ab" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${id})`} />
      <path d="M346 136H206a62 62 0 0 0 0 124h100a62 62 0 0 1 0 124H190" fill="none" stroke="#fff" strokeWidth="36" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="362" cy="136" r="34" fill="#fff" />
      <circle cx="166" cy="384" r="62" fill="#fff" />
      <path d="M138 384l20 20 36-40" fill="none" stroke="#1971c2" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
