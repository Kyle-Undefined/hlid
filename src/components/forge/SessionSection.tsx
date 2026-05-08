import { PrivacyToggle } from "#/components/nav/PrivacyToggle";
import { useWs } from "#/hooks/useWs";
import { Field, Section } from "./fields";

export function SessionSection() {
	const { send } = useWs();

	function reloadSession() {
		send({ type: "reload_session" });
	}

	return (
		<Section title="Session">
			<Field
				label="Reload session"
				hint="restarts Claude with the current config and wipes conversation history"
			>
				<button
					type="button"
					onClick={reloadSession}
					className="text-[10px] tracking-widest px-3 py-1.5 border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors uppercase"
				>
					RELOAD
				</button>
			</Field>
			<Field
				label="Privacy mode"
				hint="blur personal data for demos (browser-local, not saved to config)"
			>
				<PrivacyToggle />
			</Field>
		</Section>
	);
}
