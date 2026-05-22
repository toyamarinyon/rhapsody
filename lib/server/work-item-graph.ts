import type { Client } from "@libsql/client";

import { listWorkItemGraph, type WorkItemGraph } from "@/lib/state";

export type EncodedWorkItemIdParam = string | string[];

type ParsedWorkItemId =
	| { ok: true; value: string }
	| { ok: false; error: string };

type LoadedWorkItemGraph =
	| { ok: true; graph: WorkItemGraph }
	| { ok: false; error: string };

const INVALID_WORK_ITEM_ID_ERROR =
	"encodedWorkItemId must be a valid URL-encoded work item id.";

export function parseEncodedWorkItemIdParam(
	value: EncodedWorkItemIdParam,
): ParsedWorkItemId {
	const segments = Array.isArray(value) ? value : [value];

	if (
		segments.length === 0 ||
		segments.some((segment) => !segment || !segment.trim())
	) {
		return {
			ok: false,
			error: INVALID_WORK_ITEM_ID_ERROR,
		};
	}

	try {
		const workItemId = decodeURIComponent(segments.join("/"));

		if (!workItemId.trim()) {
			return {
				ok: false,
				error: INVALID_WORK_ITEM_ID_ERROR,
			};
		}

		return { ok: true, value: workItemId };
	} catch {
		return {
			ok: false,
			error: INVALID_WORK_ITEM_ID_ERROR,
		};
	}
}

export async function loadWorkItemGraphForRouteParam(
	client: Client,
	value: EncodedWorkItemIdParam,
): Promise<LoadedWorkItemGraph> {
	const parsed = parseEncodedWorkItemIdParam(value);

	if (!parsed.ok) {
		return parsed;
	}

	return {
		ok: true,
		graph: await listWorkItemGraph(client, parsed.value),
	};
}
