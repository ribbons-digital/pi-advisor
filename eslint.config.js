import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: [
			"coverage/**",
			"dist/**",
			"node_modules/**",
			"eslint.config.js",
			"prettier.config.js",
			"docs/internal/**",
			"tools/oxlint/anti-slop/**",
		],
	},
	eslint.configs.recommended,
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/consistent-type-imports": "error",
			"@typescript-eslint/no-confusing-void-expression": "off",
		},
	},
);
