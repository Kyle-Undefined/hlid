import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
	applyThemeToDocument,
	type CustomThemePalette,
	type ThemeName,
} from "#/lib/theme";
import type { AuthState } from "#/server/auth";
import { LoginForm } from "./-LoginForm";

type AuthStatus = {
	state: AuthState;
	theme: ThemeName;
	mobileTheme?: ThemeName;
	customTheme?: CustomThemePalette;
	mobileCustomTheme?: CustomThemePalette;
};

function applyTheme(status: AuthStatus): void {
	const selected =
		status.mobileTheme && window.matchMedia("(pointer: coarse)").matches
			? status.mobileTheme
			: status.theme;
	const palette =
		selected === "custom"
			? status.mobileTheme === "custom" &&
				window.matchMedia("(pointer: coarse)").matches
				? (status.mobileCustomTheme ?? status.customTheme)
				: status.customTheme
			: undefined;
	localStorage.setItem("hlid-theme", selected);
	if (palette)
		localStorage.setItem("hlid-theme-palette", JSON.stringify(palette));
	else localStorage.removeItem("hlid-theme-palette");
	applyThemeToDocument(selected, palette);
}

export const Route = createFileRoute("/login")({ component: LoginPage });

export function LoginPage() {
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
					<LoginForm
						state={state}
						password={password}
						confirm={confirm}
						error={error}
						working={working}
						onPasswordChange={setPassword}
						onConfirmChange={setConfirm}
						onSubmit={(event) => void submit(event)}
					/>
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
