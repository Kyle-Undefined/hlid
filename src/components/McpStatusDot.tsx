/**
 * Simple tri-state status indicator dot.
 *   ok=true  → green
 *   ok=false → red/destructive
 *   ok=null  → muted grey (unknown / loading)
 */
export function StatusDot({
	ok,
	label,
}: {
	ok: boolean | null;
	label?: string;
}) {
	const cls =
		ok === true
			? "bg-emerald-500"
			: ok === false
				? "bg-destructive"
				: "bg-muted-foreground/40";
	return label ? (
		<span
			role="img"
			aria-label={label}
			className={`inline-block w-2 h-2 rounded-full ${cls}`}
		/>
	) : (
		<span
			aria-hidden="true"
			className={`inline-block w-2 h-2 rounded-full ${cls}`}
		/>
	);
}
