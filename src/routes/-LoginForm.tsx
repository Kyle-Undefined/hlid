import type { AuthState } from "#/server/auth";

/** Password entry form for both first-run setup and normal unlock. */
export function LoginForm({
	state,
	password,
	confirm,
	error,
	working,
	onPasswordChange,
	onConfirmChange,
	onSubmit,
}: {
	state: AuthState;
	password: string;
	confirm: string;
	error: string | null;
	working: boolean;
	onPasswordChange: (value: string) => void;
	onConfirmChange: (value: string) => void;
	onSubmit: (event: React.FormEvent) => void;
}) {
	return (
		<form onSubmit={onSubmit} className="space-y-4">
			<div>
				<h2 className="text-base text-foreground">
					{state === "setup-required" ? "Create app password" : "Unlock Hlid"}
				</h2>
				<p className="text-xs text-muted-foreground mt-1">
					{state === "setup-required"
						? "This first-time step is available only on the Hlid machine."
						: "This device will remain trusted for 30 days."}
				</p>
			</div>
			<div className="space-y-1.5">
				<label
					htmlFor="app-password"
					className="block text-[10px] tracking-widest uppercase text-muted-foreground"
				>
					Password
				</label>
				<input
					id="app-password"
					type="password"
					value={password}
					onChange={(event) => onPasswordChange(event.target.value)}
					autoComplete={
						state === "setup-required" ? "new-password" : "current-password"
					}
					minLength={12}
					maxLength={256}
					required
					aria-describedby={
						state === "setup-required" ? "new-password-requirements" : undefined
					}
					className="w-full bg-secondary border border-border px-3 py-2 text-sm focus:outline-none focus:border-primary/60"
				/>
				{state === "setup-required" && (
					<span
						id="new-password-requirements"
						className="block text-xs text-muted-foreground leading-relaxed"
					>
						Use 12 to 256 characters. There are no uppercase, number, or symbol
						requirements.
					</span>
				)}
			</div>
			{state === "setup-required" && (
				<div className="space-y-1.5">
					<label
						htmlFor="confirm-app-password"
						className="block text-[10px] tracking-widest uppercase text-muted-foreground"
					>
						Confirm password
					</label>
					<input
						id="confirm-app-password"
						type="password"
						value={confirm}
						onChange={(event) => onConfirmChange(event.target.value)}
						autoComplete="new-password"
						minLength={12}
						maxLength={256}
						required
						className="w-full bg-secondary border border-border px-3 py-2 text-sm focus:outline-none focus:border-primary/60"
					/>
				</div>
			)}
			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
			<button
				type="submit"
				disabled={working || password.length < 12}
				className="w-full border border-primary bg-primary text-primary-foreground py-2 text-[10px] tracking-widest uppercase disabled:opacity-40"
			>
				{working
					? "Please wait…"
					: state === "setup-required"
						? "Set password"
						: "Unlock"}
			</button>
		</form>
	);
}
