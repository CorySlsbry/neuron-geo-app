// Flat ESLint config (ESLint 9).
// Composed manually from @typescript-eslint + eslint-plugin-boundaries so it
// depends only on packages we explicitly install (no guessing at a config
// preset's internal flat-config shape). Next-specific rules are layered in
// via @next/eslint-plugin-next once available.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import boundaries from "eslint-plugin-boundaries";

export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      ".vitest/**",
      "next-env.d.ts",
      "drizzle/**",
      "**/*.config.*",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      boundaries,
    },
    settings: {
      "boundaries/include": ["src/**/*"],
      // Resolve the `@/*` → `src/*` TS path alias so the boundary rules see
      // real files (without this, aliased cross-module imports are silently
      // unclassified and enforcement does nothing).
      "import/resolver": {
        typescript: { alwaysTryTypes: true, project: "./tsconfig.json" },
        node: true,
      },
      "boundaries/elements": [
        { type: "app", pattern: "src/app", mode: "folder" },
        { type: "proxy", pattern: "src/proxy.ts", mode: "file" },
        { type: "lib", pattern: "src/lib/*", mode: "folder", capture: ["lib"] },
        { type: "module", pattern: "src/modules/*", mode: "folder", capture: ["module"] },
      ],
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // THE MODULE PORT RULE — another element may import a domain module only
      // through its public index.ts, never a deep path into its internals.
      // A deliberate cross-module deep import must fail lint (S0 acceptance).
      "boundaries/entry-point": [
        "error",
        {
          default: "disallow",
          rules: [
            { target: ["module"], allow: "index.ts" },
            { target: ["lib"], allow: "**" },
            { target: ["app"], allow: "**" },
            { target: ["proxy"], allow: "**" },
          ],
        },
      ],
      // Dependency direction — domain modules may depend on other modules and
      // lib, but never on the app/HTTP layer (keeps domain logic framework-free).
      "boundaries/element-types": [
        "error",
        {
          default: "allow",
          rules: [
            {
              from: ["module"],
              disallow: ["app", "proxy"],
              message: "A domain module must not import the app/HTTP layer.",
            },
          ],
        },
      ],
    },
  },
];
