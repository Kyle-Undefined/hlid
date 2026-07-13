import { defineConfig } from 'bumpp';

export default defineConfig({
	release: 'patch',
	confirm: false,
	commit: false,
	tag: false,
	push: false,
	files: ['package.json'],
});