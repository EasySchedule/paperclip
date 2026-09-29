import { describe, expect, it, vi } from "vitest";
import { gradeConfirmationReply, assertAmbiguousReplyUnresolved, ambiguousConfirmationFixtures } from "./confirmation-replies.js";
import { firstTaskScenario } from "./first-task-cases.js";
import type { FirstTaskEvidence } from "./first-task-scoring.js";
import { provisionFirstTaskFixtures } from "./first-task-fixtures.js";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

function recording(rejected = false): FirstTaskEvidence {
  const caseId = rejected ? "reject-no-execution" : "task-reply-accept";
  const scenario = firstTaskScenario(caseId, "oracle");
  const card = { id: "proposal", kind: "request_confirmation", status: "pending" };
  const base = { issueId: "onboard", tasks: [{ id: "onboard" }], agents: [], comments: [], interactions: [card], documents: [], runs: [] };
  const message = { id: "user-answer", authorUserId: "user", body: rejected ? scenario.rejection : scenario.acceptance, createdAt: "2026-09-29T00:01:00Z" };
  return { caseId, nonce: "oracle", onboardingIssueId: "onboard", agentId: "planner", initialTaskIds: ["onboard"], instructions: [], configuredModel: null, observedModels: [], checks: [], checkpoints: [
    { ...base, id: "before", phase: "response", at: "2026-09-29T00:00:00Z" },
    { ...base, id: "decision", phase: rejected ? "rejected" : "accepted", at: message.createdAt, comments: [message] },
    { ...base, id: "after", phase: "finished", at: "2026-09-29T00:03:00Z", comments: [message], runs: [{ id: "resolver", agentId: "planner" }],
      tasks: [{ id: "onboard" }, ...rejected ? [] : [{ id: "child", createdAt: "2026-09-29T00:02:01Z" }]],
      interactions: [{ ...card, status: rejected ? "rejected" : "accepted", resolvedAt: "2026-09-29T00:02:00Z", resolvedByAgentId: "planner", resolvedByRunId: "resolver", result: { outcome: rejected ? "rejected" : "accepted", commentId: message.id } }] },
  ] };
}
describe("confirmation-reply independent oracle", () => {
  it("uses valid public confirmation fixtures without treating checkbox defaults as consent", () => {
    expect(ambiguousConfirmationFixtures).toHaveLength(2);
    const checkbox = ambiguousConfirmationFixtures[1]!;
    expect(checkbox.kind).toBe("request_checkbox_confirmation");
    expect(checkbox.payload).toMatchObject({ minSelected: 1, defaultSelectedOptionIds: ["poster"] });
  });
  it.each([false, true])("accepts the recorded decision with provenance (rejection=%s)", rejected => {
    expect(gradeConfirmationReply(recording(rejected)).every(c => c.passed)).toBe(true);
  });
  it.each(["pending", "expired", "wrong-message", "wrong-agent", "no-run", "wrong-run-agent", "missing-time", "no-card", "too-late", "multiple-pending", "opposite"])("rejects plausible wrong outcome: %s", kind => {
    const e = recording(), last = e.checkpoints.at(-1)!, card = last.interactions[0]!;
    if (kind === "pending" || kind === "expired") card.status = kind;
    if (kind === "wrong-message") card.result.commentId = "another-message";
    if (kind === "wrong-agent") card.resolvedByAgentId = "someone-else";
    if (kind === "no-run") last.runs = [];
    if (kind === "wrong-run-agent") last.runs[0]!.agentId = "someone-else";
    if (kind === "missing-time") delete card.resolvedAt;
    if (kind === "no-card") e.checkpoints[0]!.interactions = [];
    if (kind === "too-late") card.resolvedAt = "2026-09-29T00:02:02Z";
    if (kind === "multiple-pending") e.checkpoints[0]!.interactions.push({ id: "another-proposal", kind: "request_confirmation", status: "pending" });
    if (kind === "opposite") card.result.outcome = "rejected";
    expect(gradeConfirmationReply(e).some(c => !c.passed)).toBe(true);
  });
  it("does not treat checkbox defaults as a persisted selection", () => {
    const e = recording(), card = e.checkpoints.at(-1)!.interactions[0]!;
    card.kind = "request_checkbox_confirmation";
    expect(gradeConfirmationReply(e).every(c => c.passed)).toBe(false);
    card.result.selectedOptionIds = ["welcome-note"];
    expect(gradeConfirmationReply(e).every(c => c.passed)).toBe(true);
  });
  it("requires clarification and no effects for ambiguous approval", () => {
    const e = { cards: [{ id: "a", status: "pending" }, { id: "b", status: "pending" }], originalIds: ["a", "b"], tasks: [], reply: "Which proposal do you mean: the note or the poster?" };
    expect(() => assertAmbiguousReplyUnresolved(e)).not.toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, cards: [{ id: "a", status: "accepted" }, e.cards[1]!] })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, tasks: [{ id: "unauthorized-task" }] })).toThrow();
    expect(() => assertAmbiguousReplyUnresolved({ ...e, reply: "Both proposals are approved." })).toThrow();
  });
  it.each(runnerMatrix.filter(e => e.suite.id === "confirmation-replies" && e.task.flow === "first_task"))("provisions the real onboarding fixture contract for $id", async execution => {
    const get = vi.fn().mockResolvedValue([{ id: "local", driver: "local" }]);
    const postSensitive = vi.fn().mockResolvedValue({ id: "secret" });
    const credential = execution.profile.credential;
    const fixtures = await provisionFirstTaskFixtures({ api: { get, postSensitive }, execution, nonce: "fixture",
      company: { id: "company", name: "Garden" }, credentials: { [credential]: "test-credential" } });
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/companies/company/environments?driver=local");
    expect(postSensitive).toHaveBeenCalledExactlyOnceWith("/api/companies/company/secrets", expect.objectContaining({ key: credential }));
    expect(fixtures.agent.id).toBe(""); // The real wizard must still create the agent.
    expect(JSON.stringify(fixtures)).not.toContain("test-credential");
  });
  it("selects exactly ten explicit-only cases using production native profiles", () => {
    const cells = runnerMatrix.filter(e => e.suite.id === "confirmation-replies");
    expect(cells).toHaveLength(10);
    expect(new Set(cells.map(c => c.profile.id))).toEqual(new Set(["runner-codex", "runner-acpx-claude"]));
    expect(new Set(cells.map(c => c.task.id)).size).toBe(5);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--suite", "confirmation-replies"]))).toHaveLength(10);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(c => c.suite.id === "confirmation-replies")).toBe(false);
  });
});
