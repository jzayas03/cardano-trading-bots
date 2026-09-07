import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "pgdata/**", "packages/dashboard/vendor/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
);
