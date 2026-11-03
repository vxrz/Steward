import { createContext, useContext } from 'react';

/**
 * The app shell's layout as pages may change it: `wide` collapses the sidebar on wide screens (the process
 * editor's full-screen mode). Pages that set it reset it when they close.
 */
export interface ShellLayout {
  wide: boolean;
  setWide: (wide: boolean) => void;
}

export const ShellLayoutContext = createContext<ShellLayout>({ wide: false, setWide: () => undefined });

export const useShellLayout = (): ShellLayout => useContext(ShellLayoutContext);
