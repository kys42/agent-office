import { tmux } from './tmux';
import { shell } from './shell';
import { mobile } from './mobile';
import { guide } from './guide';
import { federation } from './federation';
import { pets } from './pets';
import { common } from './common';
import { app } from './app';
import { palette } from './palette';
import { inspector } from './inspector';
import { conversation } from './conversation';
import { memory } from './memory';
import { artifacts } from './artifacts';
import { settings } from './settings';
import { zoneEditor } from './zoneEditor';
import { usage } from './usage';
import { office } from './office';
import { roster } from './roster';
import { lounge } from './lounge';
import { shared } from './shared';
import { demo } from './demo';
import { server } from './server';
import { desktop } from './desktop';
import { dock } from './dock';
import { desk } from './desk';
import { terminal } from './terminal';
import { prompts } from './prompts';
import { summonExisting } from './summonExisting';

/** English is the source catalog: every other language must match its shape. */
export const en = {
  tmux,
  shell,
  mobile,
  federation,
  common,
  app,
  palette,
  inspector,
  conversation,
  memory,
  artifacts,
  settings,
  zoneEditor,
  usage,
  office,
  roster,
  lounge,
  shared,
  demo,
  server,
  desktop,
  dock,
  desk,
  terminal,
  prompts,
  pets,
  guide,
  summonExisting,
};

export type Messages = typeof en;
