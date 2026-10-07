import { createContext, useContext } from 'react';
import type { PetCustomization } from '../shared/pets';

export const PetAppearanceContext = createContext<PetCustomization | undefined>(undefined);
export const usePetAppearance = () => useContext(PetAppearanceContext);
