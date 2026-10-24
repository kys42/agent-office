import { readFile } from 'node:fs/promises';

/** Keep SDK createRequire(import.meta.url) valid in our self-contained CommonJS bundles. */
export const sdkImportMeta = {
  name: 'sdk-import-meta-in-cjs',
  setup(build) {
    build.onLoad(
      { filter: /[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/].*\.mjs$/ },
      async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replaceAll(
          'import.meta.url',
          'require("node:url").pathToFileURL(__filename).href',
        ),
        loader: 'js',
      }),
    );
  },
};
