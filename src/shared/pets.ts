import { m } from './i18n';
import type { Provider, Session } from './types';

/** Appearance is independent of the provider and the observed session state. */
export const PET_CHARACTERS = {
  claude: {
    get name() {
      return m().pets.characters.claude.name;
    },
    get description() {
      return m().pets.characters.claude.description;
    },
    kind: 'original',
  },
  codex: {
    get name() {
      return m().pets.characters.codex.name;
    },
    get description() {
      return m().pets.characters.codex.description;
    },
    kind: 'original',
  },
  openclaw: {
    get name() {
      return m().pets.characters.openclaw.name;
    },
    get description() {
      return m().pets.characters.openclaw.description;
    },
    kind: 'original',
  },
  slime: {
    get name() {
      return m().pets.characters.slime.name;
    },
    get description() {
      return m().pets.characters.slime.description;
    },
    kind: 'new',
  },
  devcat: {
    get name() {
      return m().pets.characters.devcat.name;
    },
    get description() {
      return m().pets.characters.devcat.description;
    },
    kind: 'new',
  },
  pebble: {
    get name() {
      return m().pets.characters.pebble.name;
    },
    get description() {
      return m().pets.characters.pebble.description;
    },
    kind: 'new',
  },
  retrobot: {
    get name() {
      return m().pets.characters.retrobot.name;
    },
    get description() {
      return m().pets.characters.retrobot.description;
    },
    kind: 'new',
  },
  cloud: {
    get name() {
      return m().pets.characters.cloud.name;
    },
    get description() {
      return m().pets.characters.cloud.description;
    },
    kind: 'new',
  },
} as const;
export type PetCharacter = keyof typeof PET_CHARACTERS;
export const PET_COLORS = {
  original: {
    get name() {
      return m().pets.colors.original;
    },
    swatch: '#e9d6b7',
  },
  mint: {
    get name() {
      return m().pets.colors.mint;
    },
    swatch: '#8bd6bd',
  },
  peach: {
    get name() {
      return m().pets.colors.peach;
    },
    swatch: '#f2ac93',
  },
  lavender: {
    get name() {
      return m().pets.colors.lavender;
    },
    swatch: '#b8a1e3',
  },
  sky: {
    get name() {
      return m().pets.colors.sky;
    },
    swatch: '#91c5ed',
  },
  butter: {
    get name() {
      return m().pets.colors.butter;
    },
    swatch: '#ead28e',
  },
} as const;
export type PetColor = keyof typeof PET_COLORS;
export const PET_ACCESSORIES = {
  get none() {
    return m().pets.accessories.none;
  },
  get beret() {
    return m().pets.accessories.beret;
  },
  get crown() {
    return m().pets.accessories.crown;
  },
  get sprout() {
    return m().pets.accessories.sprout;
  },
  get ribbon() {
    return m().pets.accessories.ribbon;
  },
  get glasses() {
    return m().pets.accessories.glasses;
  },
} as const;
export type PetAccessory = keyof typeof PET_ACCESSORIES;
export interface PetLook {
  character: PetCharacter;
  color: PetColor;
  accessory: PetAccessory;
}
/** null entries are deletion commands on write, and are omitted from stored preferences. */
export interface PetCustomization {
  version: 1;
  providers: Partial<Record<Provider, PetLook | null>>;
  colleagues: Record<string, PetLook | null>;
}
export const defaultPetLook = (provider: Provider): PetLook => ({
  character: provider,
  color: 'original',
  accessory: 'none',
});
export const petKey = (session: Pick<Session, 'id' | 'actor'>) =>
  session.actor ? `actor:${session.actor.id}` : session.id;
const owns = (object: object, key: unknown): key is string =>
  typeof key === 'string' && Object.hasOwn(object, key);
export function validPetLook(value: unknown): value is PetLook {
  if (!value || typeof value !== 'object') return false;
  const look = value as PetLook;
  return (
    owns(PET_CHARACTERS, look.character) &&
    owns(PET_COLORS, look.color) &&
    owns(PET_ACCESSORIES, look.accessory)
  );
}
export function normalizePetCustomization(value: unknown): PetCustomization {
  const empty: PetCustomization = { version: 1, providers: {}, colleagues: {} };
  if (!value || typeof value !== 'object' || (value as PetCustomization).version !== 1)
    return empty;
  const input = value as PetCustomization;
  for (const provider of ['claude', 'codex', 'openclaw'] as const) {
    const look = input.providers?.[provider];
    if (validPetLook(look)) empty.providers[provider] = { ...look };
  }
  if (input.colleagues && typeof input.colleagues === 'object') {
    empty.colleagues = Object.fromEntries(
      Object.entries(input.colleagues)
        .filter(([key, look]) => key.length > 0 && key.length <= 500 && validPetLook(look))
        .slice(0, 3000)
        .map(([key, look]) => [key, { ...look! }]),
    );
  }
  return empty;
}
export function mergePetCustomization(current: unknown, patch: PetCustomization): PetCustomization {
  const previous = normalizePetCustomization(current);
  return normalizePetCustomization({
    version: 1,
    providers: { ...previous.providers, ...patch.providers },
    colleagues: { ...previous.colleagues, ...patch.colleagues },
  });
}
export function petLook(
  provider: Provider,
  customization?: PetCustomization,
  session?: Pick<Session, 'id' | 'actor'>,
): PetLook {
  if (customization?.version !== 1) return defaultPetLook(provider);
  const individual = session ? customization.colleagues?.[petKey(session)] : undefined;
  const inherited = customization.providers?.[provider];
  return validPetLook(individual)
    ? individual
    : validPetLook(inherited)
      ? inherited
      : defaultPetLook(provider);
}
export function petAssets(look: PetLook) {
  const stem = look.color === 'original' ? look.character : `${look.character}-${look.color}`;
  return {
    id: `pet.${look.character}.v1`,
    sheet: `./sprites/${stem}.png`,
    walk: `./sprites/${stem}_walk.png`,
    decoration:
      look.accessory === 'none'
        ? undefined
        : `./sprites/wardrobe/${look.character}-${look.accessory}.png`,
    decorationWalk:
      look.accessory === 'none'
        ? undefined
        : `./sprites/wardrobe/${look.character}-${look.accessory}_walk.png`,
  };
}
