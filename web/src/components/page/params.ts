import { useSearchParams } from 'react-router-dom';

type ParamValue = string | readonly string[] | null | undefined;

/**
 * The filters of a list in the address (?q=…&kind=…), so a filtered list can be shared and survives a reload:
 * `params` to read them, `set` to change one (empty removes it; an array sets the key once per value), `setAll` to
 * change several at once (one address change: two `set` calls in a row would each start from the same address).
 */
export function useListParams(): {
  params: URLSearchParams;
  set: (key: string, value: ParamValue) => void;
  setAll: (values: Record<string, ParamValue>) => void;
} {
  const [params, setParams] = useSearchParams();
  const setAll = (values: Record<string, ParamValue>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(values)) {
          next.delete(key);
          for (const v of typeof value === 'string' ? [value] : (value ?? [])) if (v) next.append(key, v);
        }
        return next;
      },
      { replace: true },
    );
  const set = (key: string, value: ParamValue) => setAll({ [key]: value });
  return { params, set, setAll };
}
