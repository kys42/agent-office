import { createContext, useContext } from 'react';
import type { DeskCustomization } from '../shared/desks';

export const DeskAppearanceContext = createContext<DeskCustomization | undefined>(undefined);
export const useDeskAppearance = () => useContext(DeskAppearanceContext);
