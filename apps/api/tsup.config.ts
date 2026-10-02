import { defineConfig } from 'tsup';

// Workspace packages export TypeScript source, so they are bundled into the
// output (noExternal) while real npm dependencies stay external.
export default defineConfig({
  entry: ['src/index.ts', 'src/scripts/seed.ts', 'src/scripts/migrate.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@huddle\//],
});
