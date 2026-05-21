import { requireAdminAuth } from "@/lib/server/admin-auth";
import { seedMediatorCredentialStateFromEnv } from "@/lib/codex/credentials";

export const runtime = "nodejs";

export async function POST(request: Request) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	try {
		const result = await seedMediatorCredentialStateFromEnv();

		return Response.json({
			seeded: true,
			accountIdPresent: result.accountIdPresent,
			updatedAt: new Date(result.updatedAt).toISOString(),
		});
	} catch (error) {
		if (error instanceof Error && error.message.includes("required")) {
			return Response.json(
				{ error: "Missing INITIAL_CHATGPT_AUTH_JSON in environment." },
				{ status: 400 },
			);
		}

		if (
			error instanceof Error &&
			error.message.includes("INITIAL_CHATGPT_AUTH_JSON")
		) {
			return Response.json({ error: error.message }, { status: 400 });
		}

		return Response.json(
			{
				error: "Failed to seed ChatGPT mediator credentials.",
				detail: serializeError(error),
			},
			{ status: 500 },
		);
	}
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}

	return { name: "UnknownError", message: String(error) };
}
