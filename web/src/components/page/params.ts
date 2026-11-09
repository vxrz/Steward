import { useSearchParams } from 'react-router-dom';

/**
 * The filters of a list in the address (?q=…&kind=…), so a filtered list can be shared and survives a reload:
 * `params` to read them, `set` to change one (empty removes it; an array sets the key once per value).
 */
export function useListParams(): { params: URLSearchParams; set: (key: string, value: string | readonly string[] | null | undefined) => void } {
  const [params, setParams] = useSearchParams();
  const set = (key: string, value: string | readonly string[] | null | undefined) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(key);
        for (const v of typeof value === 'string' ? [value] : (value ?? [])) if (v) next.append(key, v);
        return next;
      },
      { replace: true },
    );
  return { params, set };
}
