export const HUMAN_REVIEW_PROJECT_STATUS = "Human Review";

export type VerifiedPullRequestHandoff = {
	number: number;
	htmlUrl: string;
	headRef: string;
	baseRef: string;
	title: string;
};

export type PostRunDecisionInput = {
	runStatus: string;
	attemptStatus: string;
	verifiedPullRequest: VerifiedPullRequestHandoff | null;
};

export type PostRunDecision =
	| {
			outcome: "requires_human_review";
			action: "move_project_item";
			targetProjectStatus: typeof HUMAN_REVIEW_PROJECT_STATUS;
			reason: string;
			pullRequest: VerifiedPullRequestHandoff;
			futureReviewEvidence: null;
	  }
	| {
			outcome: "verification_failure";
			action: "none";
			targetProjectStatus: null;
			reason: string;
			pullRequest: null;
			futureReviewEvidence: null;
	  };

export function decidePostRunAction(input: PostRunDecisionInput): PostRunDecision {
	if (
		input.runStatus === "completed" &&
		input.attemptStatus === "completed" &&
		input.verifiedPullRequest
	) {
		return {
			outcome: "requires_human_review",
			action: "move_project_item",
			targetProjectStatus: HUMAN_REVIEW_PROJECT_STATUS,
			reason:
				"MVP policy requires human review for every completed run with a verified pull request handoff.",
			pullRequest: input.verifiedPullRequest,
			futureReviewEvidence: null,
		};
	}

	return {
		outcome: "verification_failure",
		action: "none",
		targetProjectStatus: null,
		reason:
			"Post-run decision did not receive a completed run with a verified pull request handoff.",
		pullRequest: null,
		futureReviewEvidence: null,
	};
}
