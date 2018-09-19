export default {
	files: [
		"src/__tests__/**/*.ts"
	],
	failFast: true,
	verbose: true,
	serial: true,
	timeout: '3m',
	compileEnhancements: false,
	extensions: [
		'ts'
	],
	require: [
		'ts-node/register'
	]
}
