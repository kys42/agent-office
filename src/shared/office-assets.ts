import type { Mood, Provider } from './types';

/** Presentation-only asset contract. Identity, status and placement never live in a skin. */
export const OFFICE_ASSET_VERSION = 1;
export const OFFICE_PALETTES = {
  oak: { top: '#f0cc96', wood: '#cea36f', edge: '#b78a59', fabric: '#4e665b', light: '#95a696' },
  lilac: { top: '#e2d5ed', wood: '#c5b3d0', edge: '#a38cae', fabric: '#75618b', light: '#c3acd5' },
  sea: { top: '#cee2dc', wood: '#9cbcb6', edge: '#7a9b98', fabric: '#476c77', light: '#9dc5cc' },
} as const;
export type OfficePalette = keyof typeof OFFICE_PALETTES;
export type OfficeAppearance = {
  palette?: OfficePalette;
  petHue?: number;
  accessory?: 'cup' | 'plant' | 'none';
};
export const FURNITURE_ASSETS = {
  desk: 'furniture.desk.joinable.v1',
  chair: 'furniture.chair.v1',
  equipment: 'props.workstation.v1',
  helper: 'furniture.helper.v1',
  sofa: 'furniture.sofa.v1',
  bed: 'furniture.bed.v1',
} as const;
export const SPRITE_ASSETS: Record<Provider, { id: string; sheet: string; walk: string }> = {
  claude: { id: 'pet.claude.v1', sheet: './sprites/claude.png', walk: './sprites/claude_walk.png' },
  codex: { id: 'pet.codex.v1', sheet: './sprites/codex.png', walk: './sprites/codex_walk.png' },
  openclaw: {
    id: 'pet.openclaw.v1',
    sheet: './sprites/openclaw.png',
    walk: './sprites/openclaw_walk.png',
  },
};
export const SPRITE_ROWS: Record<Mood, number> = {
  idle: 0,
  work: 1,
  think: 2,
  call: 3,
  done: 4,
  error: 5,
  sleep: 6,
  leave: 7,
};
