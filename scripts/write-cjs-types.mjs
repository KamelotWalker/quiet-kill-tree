// Keeps `dist/index.d.cts` a re-export of the ESM declarations instead of a
// second full copy of the public types. tsup emits both copies; this runs
// after the build because tsup's `onSuccess` fires before dts is written.
import { writeFile } from 'node:fs/promises';

await writeFile('dist/index.d.cts', "export * from './index.js';\n");
