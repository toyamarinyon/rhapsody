import { loadRhapsodyConfig } from "@/lib/config";
import {
	buildInstructionContext,
	InstructionTemplateError,
	loadRepositoryInstructions,
	renderRepositoryInstructions,
} from "@/lib/instructions";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { createStateStoreClient, getRunDetail } from "@/lib/state";

export const runtime = "nodejs";

export async function GET(
	request: Request,
	context: { params: Promise<{ runId: string; attemptId: string }> },
) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const { runId, attemptId } = await context.params;
	const client = createStateStoreClient();

	try {
		const detail = await getRunDetail(client, runId);

		if (!detail) {
			return Response.json({ error: "Run not found." }, { status: 404 });
		}

		const attempt = detail.attempts.find((candidate) => candidate.id === attemptId);

		if (!attempt) {
			return Response.json({ error: "Attempt not found." }, { status: 404 });
		}

		const config = loadRhapsodyConfig();
		const instructions = await loadRepositoryInstructions();
		const prompt = renderRepositoryInstructions({
			template: instructions.template,
			context: buildInstructionContext({ detail, attempt, config }),
		});

		return Response.json({ prompt, instructionPath: instructions.instructionPath });
	} catch (error) {
		if (error instanceof InstructionTemplateError) {
			return Response.json({ error: error.message }, { status: 422 });
		}

		throw error;
	} finally {
		client.close();
	}
}
