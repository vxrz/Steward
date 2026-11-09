import type { ReactNode } from 'react';

/** Values joined by " · ": a line breaks between them, never inside one (a MAC, a VLAN name, a switch port). */
export function Tokens({ values, empty = null }: { values: string[]; empty?: ReactNode }) {
  const list = values.filter(Boolean);
  if (!list.length) return <>{empty}</>;
  return (
    <>
      {list.map((v, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          <span className="nowrap">{v}</span>
        </span>
      ))}
    </>
  );
}
