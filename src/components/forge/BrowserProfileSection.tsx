import type { ProjectPreviewForm } from "#/lib/settingsForm";
import { Field, Section } from "./fields";

export function BrowserProfileSection({
	value,
	onChange,
}: {
	value: ProjectPreviewForm;
	onChange: (patch: Partial<ProjectPreviewForm>) => void;
}) {
	return (
		<Section
			title="Browser profile"
			description="Choose whether agent-controlled Project Preview tabs use an isolated browser or your running Chromium profile."
		>
			<Field
				label="Use real browser profile"
				hint="Off by default. Applies when Hlid opens the next agent-controlled Preview browser session."
			>
				<label className="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={value.useRealBrowserProfile}
						onChange={(event) =>
							onChange({
								useRealBrowserProfile: event.target.checked,
							})
						}
						className="w-3.5 h-3.5 accent-primary"
					/>
					<span className="text-xs text-muted-foreground">
						{value.useRealBrowserProfile ? "on" : "off"}
					</span>
				</label>
			</Field>
			{value.useRealBrowserProfile && (
				<div
					role="alert"
					className="mx-4 mb-4 border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-foreground"
				>
					<div className="font-medium text-destructive">Sensitive access</div>
					<div className="mt-1 text-muted-foreground">
						Agent-controlled Preview tabs may access cookies, local and session
						storage, saved sign-ins, and other site data in your browser
						profile. Use this only with agents and projects you trust.
					</div>
					<div className="mt-2 text-muted-foreground">
						Your running Chromium browser must support consented remote
						debugging and have it enabled at{" "}
						<span className="font-mono text-foreground">
							chrome://inspect/#remote-debugging
						</span>
						, or the browser-specific equivalent such as{" "}
						<span className="font-mono text-foreground">
							brave://inspect/#remote-debugging
						</span>
						. The browser will ask you to approve the connection.
					</div>
				</div>
			)}
		</Section>
	);
}
