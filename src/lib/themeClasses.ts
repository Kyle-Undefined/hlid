/**
 * Shared theme-role pairings. Keep surfaces and their intended foregrounds
 * together so a custom palette cannot change one half of a component contract.
 */
export const themeSurfaceClass = {
	card: "bg-card text-card-foreground",
	popover: "bg-popover text-popover-foreground",
	secondary: "bg-secondary text-secondary-foreground",
	input: "bg-input text-foreground",
	sidebar: "bg-sidebar text-sidebar-foreground",
	accentAction: "hover:bg-accent hover:text-accent-foreground",
	sidebarAction:
		"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring",
} as const;

/**
 * Semantic states use palette roles rather than literal Tailwind colors.
 * Primary remains the running state; destructive remains failure.
 */
export const semanticStatusClass = {
	success: {
		text: "text-status-success",
		textMuted: "text-status-success/70",
		dot: "bg-status-success",
		surface:
			"border-status-success/30 bg-status-success/10 text-status-success",
		surfaceQuiet: "border-status-success/30 bg-status-success/5",
		action: "text-status-success/70 hover:bg-status-success/5",
	},
	warning: {
		text: "text-status-warning",
		textMuted: "text-status-warning/80",
		dot: "bg-status-warning",
		surface:
			"border-status-warning/30 bg-status-warning/10 text-status-warning",
		surfaceQuiet: "border-status-warning/30 bg-status-warning/5",
		action: "text-status-warning/80 hover:bg-status-warning/5",
	},
	info: {
		text: "text-status-info",
		textMuted: "text-status-info/75",
		dot: "bg-status-info",
		surface: "border-status-info/30 bg-status-info/10 text-status-info",
		surfaceQuiet: "border-status-info/30 bg-status-info/5",
		action: "text-status-info/75 hover:bg-status-info/5",
	},
	danger: {
		text: "text-destructive",
		textMuted: "text-destructive/70",
		dot: "bg-destructive",
		surface: "border-destructive/30 bg-destructive/10 text-destructive",
		surfaceQuiet: "border-destructive/30 bg-destructive/5",
		action: "text-destructive/70 hover:bg-destructive/5",
	},
	running: {
		text: "text-primary",
		textMuted: "text-primary/70",
		dot: "bg-primary",
		surface: "border-primary/30 bg-primary/10 text-primary",
		surfaceQuiet: "border-primary/30 bg-primary/5",
		action: "text-primary/70 hover:bg-primary/5",
	},
} as const;

/**
 * Intentional literal-color boundaries:
 * - diff additions and deletions keep conventional red/green pairs;
 * - syntax tokens and Markdown alert categories need a larger categorical
 *   palette than the application status roles;
 * - permission session/always scopes and exact-reference kinds are product
 *   categories, not success or warning states;
 * - neutral modal scrims and sandboxed document backgrounds are presentation
 *   boundaries rather than application surfaces.
 */
