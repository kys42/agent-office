import type { Mood, Provider } from './types';

/** Presentation-only asset contract. Identity, status and placement never live in a skin. */
export const OFFICE_ASSET_VERSION = 1;
/**
 * Desk tops and lounge fabric. `rim` is the lit front edge, `side` the dark ends and underside,
 * `leg` the legs; oak keeps the colours the bench always had.
 */
export const OFFICE_PALETTES = {
  oak: {
    top: '#f0cc96',
    wood: '#cea36f',
    edge: '#b78a59',
    fabric: '#4e665b',
    light: '#95a696',
    rim: '#ffe2ab',
    side: '#6e4a3a',
    leg: '#5e3f33',
  },
  walnut: {
    top: '#b27b52',
    wood: '#8a5a3b',
    edge: '#6b4229',
    fabric: '#4e665b',
    light: '#95a696',
    rim: '#d6a073',
    side: '#4a2c1f',
    leg: '#3e251a',
  },
  birch: {
    top: '#f8ebcd',
    wood: '#e6cf9f',
    edge: '#c9ad78',
    fabric: '#4e665b',
    light: '#95a696',
    rim: '#fff7e3',
    side: '#8a6a48',
    leg: '#76593c',
  },
  white: {
    top: '#f7f5f0',
    wood: '#e2ddd3',
    edge: '#c3bcae',
    fabric: '#4e665b',
    light: '#95a696',
    rim: '#ffffff',
    side: '#8d877c',
    leg: '#77726a',
  },
  charcoal: {
    top: '#6a6d74',
    wood: '#4b4e55',
    edge: '#393b41',
    fabric: '#4e665b',
    light: '#95a696',
    rim: '#8c9098',
    side: '#25262b',
    leg: '#1e1f23',
  },
  lilac: {
    top: '#e2d5ed',
    wood: '#c5b3d0',
    edge: '#a38cae',
    fabric: '#75618b',
    light: '#c3acd5',
    rim: '#f3eafa',
    side: '#5e4a6b',
    leg: '#4f3d5a',
  },
  sea: {
    top: '#cee2dc',
    wood: '#9cbcb6',
    edge: '#7a9b98',
    fabric: '#476c77',
    light: '#9dc5cc',
    rim: '#e6f3ef',
    side: '#3f5c5c',
    leg: '#344d4d',
  },
  mint: {
    top: '#d3f0dc',
    wood: '#a7d4b5',
    edge: '#82b393',
    fabric: '#4e7a62',
    light: '#a6d2b4',
    rim: '#ecfbf0',
    side: '#436650',
    leg: '#385743',
  },
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
  // Standing by shares the calm seated row; its posture (upright, no dozing) tells it apart.
  ready: 0,
  work: 1,
  think: 2,
  call: 3,
  done: 4,
  error: 5,
  sleep: 6,
  leave: 7,
};
