export function label(value: boolean): "yes" | "no" {
	return value ? "yes" : "no";
}

export function typeJson(value: Record<string, unknown>): string {
	return JSON.stringify(value, null, 2);
}
