import type { ProviderInfo } from "#/lib/providerTypes";
import { ModeProviderPicker } from "./ModeProviderPicker";
import { ProviderOptionFields } from "./ProviderOptionFields";

export type AgentConfigurationValue = {
	mode: "cwd" | "context";
	provider: string;
	model: string;
	effort: string;
	maxTurns: string;
	permissionMode: string;
	recapModel: string;
	interactiveMode?: boolean;
};

export function AgentConfigurationFields({
	value,
	providers,
	onChange,
	includeInteractive = false,
}: {
	value: AgentConfigurationValue;
	providers: ProviderInfo[];
	onChange: (patch: Partial<AgentConfigurationValue>) => void;
	includeInteractive?: boolean;
}) {
	const activeProvider = providers.find(
		(provider) => provider.id === value.provider,
	);
	const unavailableReason =
		activeProvider?.available === false
			? (activeProvider.unavailableReason ?? "unavailable")
			: null;

	return (
		<>
			<ModeProviderPicker
				mode={value.mode}
				provider={value.provider}
				providers={providers}
				unavailableReason={unavailableReason}
				onModeChange={(mode) => onChange({ mode })}
				onProviderChange={(provider) => onChange({ provider })}
			/>
			<ProviderOptionFields
				value={value}
				activeProvider={activeProvider}
				includeInteractive={includeInteractive}
				onChange={onChange}
			/>
		</>
	);
}
