import { request, readConnection } from './protocol.js';
async function main() {
  const [file, command = 'help', raw = '{}'] = process.argv.slice(2);
  if (command === 'help') {
    console.log(
      JSON.stringify({
        commands: {
          overview: '{since?: epoch milliseconds}',
          show_agents: '{ids: string[]} — display up to 8 selected colleagues in the chat',
          show_briefing: '{} — display an observed office status card in the chat',
          news: '{since?: epoch milliseconds, before?: {at: number, id: string}}',
          search: '{query: string}',
          detail: '{id: string}',
          zones: '{}',
          focus: '{id: string}',
          move: '{id: string, zoneKey?: existing key, name?: new area name}',
          return: '{id: string}',
          pin: '{id: string, on: boolean}',
          handoff: '{id: string, revision: string}',
        },
      }),
    );
    return;
  }
  if (!file) throw new Error('Run the office helper from the manager workspace.');
  const result = await request(await readConnection(file), command, JSON.parse(raw));
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
