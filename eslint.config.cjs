const typescriptEslintPlugin = require("@typescript-eslint/eslint-plugin");
const prettier = require("eslint-plugin-prettier");
const globals = require("globals");
const tsParser = require("@typescript-eslint/parser");
const js = require("@eslint/js");

const {
    FlatCompat,
} = require("@eslint/eslintrc");

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
});

module.exports = [
    ...compat.extends(
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "prettier",
    "plugin:prettier/recommended",
), {
    plugins: {
        "@typescript-eslint": typescriptEslintPlugin,
        "prettier": prettier,
    },
    
    languageOptions: {
        globals: {
            ...globals.node,
        },
        
        parser: tsParser,
        ecmaVersion: 5,
        sourceType: "module",
        
        parserOptions: {
            project: "tsconfig.json",
        },
    },
    
    rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
}];
