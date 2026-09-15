import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/**', 'out/**', 'node_modules/**'] },
	...tseslint.configs.recommended,
	{
		files: ['src/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
		},
	},
);
