import { createContext, useContext } from 'react';
import type { RoleFocus } from './role-focus.js';

/**
 * The signed-in user's focus (config/role_focus.json), given by the app shell to everything it
 * frames. Outside the shell there is none, and every list keeps its usual order.
 */
export const RoleFocusContext = createContext<RoleFocus | null>(null);

export function useRoleFocus(): RoleFocus | null {
  return useContext(RoleFocusContext);
}
