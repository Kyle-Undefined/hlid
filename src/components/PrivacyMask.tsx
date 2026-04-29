import { useSyncExternalStore } from "react";
import * as privacyStore from "#/hooks/privacyStore";
import { cn } from "#/lib/utils";

interface PrivacyMaskProps {
	children: React.ReactNode;
	className?: string;
	inline?: boolean;
}

const BLUR_STYLE: React.CSSProperties = {
	filter: "blur(6px)",
	userSelect: "none",
	pointerEvents: "none",
	transition: "filter 200ms ease",
};

const CLEAR_STYLE: React.CSSProperties = {
	transition: "filter 200ms ease",
};

export function PrivacyMask({ children, className, inline }: PrivacyMaskProps) {
	const isPrivate = useSyncExternalStore(
		privacyStore.subscribe,
		privacyStore.getSnapshot,
		() => false,
	);
	const Tag = inline ? "span" : "div";
	return (
		<Tag className={cn(className)} style={isPrivate ? BLUR_STYLE : CLEAR_STYLE}>
			{children}
		</Tag>
	);
}
