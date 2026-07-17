import { createContext, type ReactNode, useContext } from "react";

export type FieldControlA11y = {
	"aria-labelledby": string;
	"aria-describedby"?: string;
};

const FieldControlContext = createContext<FieldControlA11y | null>(null);

export function FieldControlProvider({
	value,
	children,
}: {
	value: FieldControlA11y;
	children: ReactNode;
}) {
	return (
		<FieldControlContext.Provider value={value}>
			{children}
		</FieldControlContext.Provider>
	);
}

/** Supplies a surrounding visible Field label and hint to a nested control. */
export function useFieldControlProps(): FieldControlA11y | undefined {
	return useContext(FieldControlContext) ?? undefined;
}
