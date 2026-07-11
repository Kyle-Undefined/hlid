import { useState } from "react";
import { Field, Section } from "./fields";

function PasswordInput({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<input
			type="password"
			value={value}
			onChange={(event) => onChange(event.target.value)}
			autoComplete="current-password"
			className="w-48 bg-secondary border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:border-primary/50"
		/>
	);
}

export function SecuritySection() {
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [message, setMessage] = useState<string | null>(null);
	const [working, setWorking] = useState(false);

	async function changePassword() {
		if (newPassword !== confirmPassword) {
			setMessage("New passwords do not match");
			return;
		}
		setWorking(true);
		setMessage(null);
		try {
			const response = await fetch("/api/auth/change-password", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ currentPassword, newPassword }),
			});
			const result = (await response.json()) as { error?: string };
			if (!response.ok) {
				setMessage(result.error ?? "Password change failed");
				return;
			}
			window.location.replace("/login");
		} finally {
			setWorking(false);
		}
	}

	async function revokeAll() {
		if (!window.confirm("Lock Hlid on every trusted device?")) return;
		setWorking(true);
		try {
			await fetch("/api/auth/revoke-all", { method: "POST" });
			window.location.replace("/login");
		} finally {
			setWorking(false);
		}
	}

	return (
		<div className="space-y-6">
			<Section title="App Password">
				<Field label="Current Password">
					<PasswordInput
						value={currentPassword}
						onChange={setCurrentPassword}
					/>
				</Field>
				<Field
					label="New Password"
					hint="12-256 characters; no composition rules"
				>
					<PasswordInput value={newPassword} onChange={setNewPassword} />
				</Field>
				<Field label="Confirm New Password">
					<PasswordInput
						value={confirmPassword}
						onChange={setConfirmPassword}
					/>
				</Field>
				<div className="px-4 py-3 flex items-center justify-between gap-4">
					<span className="text-xs text-muted-foreground">
						Changing the password locks every trusted device.
					</span>
					<button
						type="button"
						onClick={() => void changePassword()}
						disabled={working || !currentPassword || !newPassword}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-primary text-primary hover:bg-primary hover:text-primary-foreground uppercase disabled:opacity-40"
					>
						Change
					</button>
				</div>
				{message && (
					<div className="px-4 py-3 text-xs text-destructive">{message}</div>
				)}
			</Section>

			<Section title="Trusted Devices">
				<Field
					label="Revoke All Devices"
					hint="Deletes every active 30-day session, including this browser."
				>
					<button
						type="button"
						onClick={() => void revokeAll()}
						disabled={working}
						className="text-[10px] tracking-widest px-3 py-1.5 border border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground uppercase disabled:opacity-40"
					>
						Revoke All
					</button>
				</Field>
			</Section>
		</div>
	);
}
