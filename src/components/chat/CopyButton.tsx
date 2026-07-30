import { Check, Copy } from "lucide-react";

interface CopyButtonProps {
	onCopy: () => void;
	copied: boolean;
	className?: string;
}

export function CopyButton({ onCopy, copied, className }: CopyButtonProps) {
	const classes = [
		"p-1 rounded-none",
		"text-muted-foreground/40 hover:text-muted-foreground/80",
		className ? undefined : "transition-all",
		className,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<button
			type="button"
			onClick={onCopy}
			aria-label={copied ? "Copied" : "Copy"}
			className={classes}
		>
			{copied ? (
				<Check aria-hidden className="w-3 h-3 text-primary/60" />
			) : (
				<Copy aria-hidden className="w-3 h-3" />
			)}
		</button>
	);
}
