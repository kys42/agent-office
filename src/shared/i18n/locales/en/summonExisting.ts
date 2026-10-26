/** Project "+" → bringing back a colleague from the lounge or the archive. */
export const summonExisting = {
  title: 'Bring back a colleague',
  description:
    'Bring a colleague of this project back from the lounge or the archive and continue their conversation in a terminal.',
  count: (n: number) => `${n}`,
  more: (n: number) => `${n} older colleagues are not listed.`,
  zone: { waiting: 'Lounge', archive: 'Archived' },
  active: (ago: string) => `Active ${ago}`,
  blocked: {
    remote: 'Remote office colleagues cannot be resumed here',
    provider: 'Only Claude and Codex conversations can be resumed',
    conversation: 'No saved conversation to resume',
    folder: 'The original project folder is unknown',
  },
  chosen: 'Colleague to bring back',
  tmuxStart: 'Bring back in tmux',
  orcaStart: 'Bring back in a new Orca tab',
  hint: 'They return to the office (archived ones are restored) once their terminal is open. A confirmation appears before anything starts.',
};
