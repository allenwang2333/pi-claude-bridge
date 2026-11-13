// Custom prompt sections travel as native system messages through SDK hooks.
// Keep the leading preset append unchanged when an extension enables or disables itself.
export class SystemUpdates {
	private delivered: Record<string, string>;
	private pending: Record<string, string>;

	constructor(previous: Record<string, string> = {}, current: Record<string, string> = previous, private reset = false) {
		this.delivered = { ...previous };
		this.pending = { ...current };
	}

	update(sections: Record<string, string>): void {
		this.pending = { ...sections };
	}

	get sections(): Record<string, string> {
		return { ...this.delivered };
	}

	/** Hooks persist this text as context on the turn that consumes it. Only then
	 *  advance the delivered state, so a tool-boundary update is not lost on abort. */
	take(): string | undefined {
		const parts: string[] = this.reset
			? ["All earlier custom system prompt sections are superseded. Only the following custom sections now apply (none if no sections follow)."]
			: [];
		for (const name of [...new Set([...Object.keys(this.delivered), ...Object.keys(this.pending)])].sort()) {
			const before = this.delivered[name] || undefined;
			const after = this.pending[name] || undefined;
			if (before === after && !this.reset) continue;
			parts.push(after
				? `Updated system prompt section "${name}":\n\n<${name}>\n${after}\n</${name}>`
				: `Removed system prompt section "${name}". Its instructions no longer apply.`);
		}
		this.delivered = { ...this.pending };
		this.reset = false;
		return parts.length ? parts.join("\n\n") : undefined;
	}
}
