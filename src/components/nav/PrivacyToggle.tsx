import { useSyncExternalStore } from "react";
import * as privacyStore from "#/hooks/privacyStore";

export function PrivacyToggle() {
	const isPrivate = useSyncExternalStore(
		privacyStore.subscribe,
		privacyStore.getSnapshot,
		() => false,
	);

	return (
		<label className="flex items-center gap-2 cursor-pointer">
			<input
				type="checkbox"
				checked={isPrivate}
				onChange={privacyStore.togglePrivacy}
				className="accent-primary w-3.5 h-3.5"
			/>
			<span className="text-xs text-muted-foreground">
				{isPrivate ? "on" : "off"}
			</span>
		</label>
	);
}
