/**
 * lint-staged configuration.
 *
 * The repo uses pnpm workspaces with per-package ESLint flat configs (today
 * only `packages/web-ui` has one). ESLint v9 flat config does NOT walk up
 * from a file's path — it looks UP from the cwd — so invoking `eslint`
 * from the workspace root with a path like `packages/web-ui/src/x.ts` fails
 * with "ESLint couldn't find an eslint.config.(js|mjs|cjs) file".
 *
 * Fix: for files in a package with its own ESLint config, run that
 * package's eslint binary with cwd = the package directory, and pass the
 * file path *relative to the package*. Prettier doesn't have this problem
 * and runs from the workspace root for everything.
 *
 * Pattern for adding more linted packages: add another entry below with the
 * same shape. Each one runs ESLint scoped to that package.
 */

const escape = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function eslintForPackage(packageDir, filterName) {
  const prefix = `${packageDir}/`;
  return (filenames) => {
    const relative = filenames
      .map((f) => f.startsWith(prefix) ? f.slice(prefix.length) : f)
      .map(escape)
      .join(' ');
    if (!relative) return [];
    return [
      `pnpm --filter ${filterName} exec eslint --fix --max-warnings=0 ${relative}`,
    ];
  };
}

export default {
  'packages/web-ui/**/*.{ts,tsx,js,jsx}': eslintForPackage(
    'packages/web-ui',
    '@shipit-ai/web-ui',
  ),
  '**/*.{ts,tsx,js,jsx,json,md,mdx,css,yml,yaml}': 'prettier --write',
};
