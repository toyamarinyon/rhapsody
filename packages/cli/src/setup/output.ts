export function toJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export function printIfJson(json: boolean, value: unknown): void {
	if (json) {
		console.log(toJson(value));
	}
}

export function printLines(lines: string[]): void {
	for (const line of lines) {
		console.log(line);
	}
}
