import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/**
 * Flat ESLint config.
 *
 * eslint-config-next 16 ships native flat configs, so these are spread
 * directly rather than going through the `@eslint/eslintrc` compat shim.
 */
export default [
  ...coreWebVitals,
  ...typescript,

  {
    rules: {
      /**
       * Downgraded to a warning, deliberately.
       *
       * This React Compiler rule flags any synchronous `setState` inside an
       * effect. That is good advice in general, and the codebase follows it —
       * empty states are derived rather than written, and state that should
       * reset on open does so by remounting.
       *
       * What remains are two patterns where it is the correct implementation
       * and there is no better one short of moving all data fetching to
       * Suspense:
       *
       *   1. Raising a loading flag immediately before an async call, so a
       *      skeleton shows while it is in flight.
       *   2. Seeding a form from persisted state or a session that only
       *      becomes available after the first render.
       *
       * Kept as a warning rather than switched off so genuinely careless uses
       * still surface in review.
       */
      "react-hooks/set-state-in-effect": "warn",
    },
  },

  {
    // Data generation scripts are plain Node and not part of the app bundle.
    ignores: [".next/**", "node_modules/**", "scripts/**"],
  },
];
