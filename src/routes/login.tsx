import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import type { AuthState } from "#/server/auth";

type AuthStatus = {
	state: AuthState;
	theme: "dark" | "tan";
	mobileTheme?: "dark" | "tan";
};

function applyTheme(status: AuthStatus): void {
	const selected =
		status.mobileTheme && window.matchMedia("(pointer: coarse)").matches
			? status.mobileTheme
			: status.theme;
	localStorage.setItem("hlid-theme", selected);
	document.documentElement.dataset.theme = selected;
	document.documentElement.className = selected;
}

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
	const navigate = useNavigate();
	const [state, setState] = useState<AuthState | null>(null);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [working, setWorking] = useState(false);

	useEffect(() => {
		fetch("/api/auth/status", { cache: "no-store" })
			.then(async (response) => {
				if (!response.ok) throw new Error("Unable to check authentication");
				return (await response.json()) as AuthStatus;
			})
			.then((result) => {
				applyTheme(result);
				if (result.state === "authenticated") window.location.replace("/");
				else setState(result.state);
			})
			.catch((reason) =>
				setError(
					reason instanceof Error ? reason.message : "Unable to continue",
				),
			);
	}, []);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!state) return;
		if (state === "setup-required" && password !== confirm) {
			setError("Passwords do not match");
			return;
		}
		setWorking(true);
		setError(null);
		try {
			const response = await fetch(
				state === "setup-required" ? "/api/auth/setup" : "/api/auth/login",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ password }),
				},
			);
			const result = (await response.json()) as { error?: string };
			if (!response.ok) {
				setError(result.error ?? "Unable to unlock Hlid");
				return;
			}
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			await new Promise<void>((resolve) =>
				requestAnimationFrame(() => resolve()),
			);
			await navigate({ to: "/", replace: true });
		} catch {
			setError("Unable to reach Hlid");
		} finally {
			setWorking(false);
		}
	}

	return (
		<main className="min-h-dvh flex items-center justify-center bg-background p-4">
			<div className="w-full max-w-sm border border-border bg-card p-6 shadow-2xl">
				<div className="flex items-center gap-3 mb-6">
					<div className="w-10 h-10 border border-primary/40 bg-primary/10 flex items-center justify-center">
						<ShieldCheck className="w-5 h-5 text-primary" />
					</div>
					<div>
						<h1 className="text-sm tracking-[0.25em] font-bold text-primary">
							HLIÐ
						</h1>
						<p className="text-[9px] tracking-widest uppercase text-muted-foreground">
							Watcher of worlds
						</p>
					</div>
				</div>

				{state ? (
					<form onSubmit={(event) => void submit(event)} className="space-y-4">
						<div>
							<h2 className="text-base text-foreground">
								{state === "setup-required"
									? "Create app password"
									: "Unlock Hlid"}
							</h2>
							<p className="text-xs text-muted-foreground mt-1">
								{state === "setup-required"
									? "This first-time step is available only on the Hlid machine."
									: "This device will remain trusted for 30 days."}
							</p>
						</div>
						<label className="block space-y-1.5">
							<span className="text-[10px] tracking-widest uppercase text-muted-foreground">
								Password
							</span>
							<input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								autoComplete={
									state === "setup-required"
										? "new-password"
										: "current-password"
								}
								minLength={12}
								maxLength={256}
								className="w-full bg-secondary border border-border px-3 py-2 text-sm focus:outline-none focus:border-primary/60"
							/>
						</label>
						{state === "setup-required" && (
							<label className="block space-y-1.5">
								<span className="text-[10px] tracking-widest uppercase text-muted-foreground">
									Confirm password
								</span>
								<input
									type="password"
									value={confirm}
									onChange={(event) => setConfirm(event.target.value)}
									autoComplete="new-password"
									minLength={12}
									maxLength={256}
									className="w-full bg-secondary border border-border px-3 py-2 text-sm focus:outline-none focus:border-primary/60"
								/>
							</label>
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
				) : (
					<p className="text-xs text-muted-foreground">Checking Hlid…</p>
				)}
				{!state && error && (
					<p role="alert" className="text-xs text-destructive mt-4">
						{error}
					</p>
				)}
			</div>
		</main>
	);
}
