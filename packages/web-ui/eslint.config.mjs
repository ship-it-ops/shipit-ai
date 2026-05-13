import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

export default [
  ...nextCoreWebVitals,
  {
    ignores: ['.next/**', 'node_modules/**', 'dist/**', '.turbo/**'],
  },
  {
    rules: {
      // react-hooks v7 (Next 16) flags any setState inside useEffect as error.
      // Our remaining call sites are genuine "sync local state to an external
      // trigger" patterns (theme-change palette resolve, palette-close query
      // reset). Keep as a warning; refactor opportunistically.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];
