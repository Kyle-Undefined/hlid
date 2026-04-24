import { defineConfig } from 'bumpp';

export default defineConfig({
	confirm: false,
	commit: false,
	tag: false,
	push: false,
	files: ['package.json'],
});