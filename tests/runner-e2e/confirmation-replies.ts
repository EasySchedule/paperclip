import { expect } from "@playwright/test";
import type { FirstTaskEvidence, FirstTaskCheck, Row } from "./first-task-scoring.js";
import { firstTaskScenario } from "./first-task-cases.js";
import { isChatClarificationReply, sendChatMessage, type ChatFlowInput, type ChatIssue } from "./chat-flow.js";

/** The independent oracle checks recorded card state, provenance and ordering, not agent claims. */
export function gradeConfirmationReply(e: FirstTaskEvidence): FirstTaskCheck[] {
  const expected = e.caseId === "reject-no-execution" ? "rejected" : "accepted";
  const decision = e.checkpoints.find(c => c.phase === expected);
  const last = e.checkpoints.at(-1);
  const scenario = firstTaskScenario(e.caseId, e.nonce);
  const reply = decision?.comments.find(c => !c.authorAgentId && c.authorUserId && c.body === (expected === "accepted" ? scenario.acceptance : scenario.rejection));
  const before = e.checkpoints.filter(c => ["response", "clarified", "revised"].includes(c.phase)).at(-1);
  const pending = before?.interactions.filter(c => c.status === "pending" && ["request_confirmation", "request_checkbox_confirmation"].includes(c.kind)) ?? [];
  const card = pending.length === 1 ? last?.interactions.find(c => c.id === pending[0]!.id) : undefined;
  const resolvedAt = Date.parse(card?.resolvedAt ?? "");
  const run = last?.runs.find(r => r.id === card?.resolvedByRunId);
  const valid = Boolean(reply && card && card.status === expected && card.result?.outcome === expected
    && card.result?.commentId === reply.id && card.resolvedByAgentId === e.agentId && run?.agentId === e.agentId
    && Number.isFinite(resolvedAt) && resolvedAt >= Date.parse(reply.createdAt ?? decision!.at)
    && (card.kind !== "request_checkbox_confirmation" || expected === "rejected" || Array.isArray(card.result?.selectedOptionIds)));
  const children = last?.tasks.filter(t => !e.initialTaskIds.includes(t.id) && t.id !== e.onboardingIssueId) ?? [];
  return [{ id: "conversation-resolves-confirmation", passed: valid,
    evidence: [before?.id, decision?.id, last?.id].filter((v): v is string => Boolean(v)),
    detail: "The exact pending proposal records the user's reply and the resolving agent run as an accepted/rejected outcome" },
  { id: "resolution-before-execution", passed: valid && children.every(t => Date.parse(t.createdAt ?? "") >= resolvedAt),
    evidence: last ? [last.id] : [], detail: "Structured approval is persisted before any child task is created" }];
}

export function assertAmbiguousReplyUnresolved(input: { cards: Row[]; originalIds: string[]; tasks: Row[]; reply: string }) {
  expect(input.originalIds).toHaveLength(2);
  expect(input.cards.filter(c => input.originalIds.includes(c.id)).map(c => c.status)).toEqual(["pending", "pending"]);
  expect(input.tasks).toHaveLength(0);
  expect(isChatClarificationReply(input.reply), "Ask which proposal the ambiguous reply refers to").toBe(true);
}

export async function runAmbiguousConfirmationReply(context: {
  input: ChatFlowInput; issue(): ChatIssue; idle(count: number): Promise<void>; comments(): Promise<Row[]>;
}) {
  const { input } = context;
  const { api, page } = input;
  await sendChatMessage(page, "I am considering a welcome note and a poster for our garden club. Neither is approved. Just acknowledge for now; do not create tasks or start either one.");
  await context.idle(1);
  const issue = context.issue();
  const cardsPath = `/api/issues/${issue.id}/interactions`;
  // Public board-created cards of different kinds retain independent pending
  // decisions, rather than depending on a model producing two simultaneous tools.
  const note = await api.post<Row>(cardsPath, { kind: "request_confirmation", title: "Welcome note proposal", continuationPolicy: "none", payload: { version: 1, prompt: "Approve writing the welcome note?" } });
  const poster = await api.post<Row>(cardsPath, { kind: "request_checkbox_confirmation", title: "Poster proposal", continuationPolicy: "none", payload: { version: 1, prompt: "Approve the poster?", options: [{ id: "poster", label: "Create a garden club poster" }], minSelected: 1 } });
  const before = await api.get<Row[]>(cardsPath);
  expect(before.filter(c => c.status === "pending").map(c => c.id).sort()).toEqual([note.id, poster.id].sort());
  await input.evidence("confirmation-before-reply.json", { issueId: issue.id, cards: before });
  await page.reload({ waitUntil: "domcontentloaded" });
  await input.capture("initial-state", "Two independent pending proposals", "initial-state.png");
  await sendChatMessage(page, "Yes, go ahead.");
  await context.idle(2);
  const e = { cards: await api.get<Row[]>(cardsPath), originalIds: [note.id, poster.id],
    tasks: await api.get<Row[]>(`/api/companies/${input.fixtures.company.id}/issues`),
    reply: (await context.comments()).filter(c => c.authorAgentId).at(-1)?.body ?? "" };
  await input.evidence("confirmation-ambiguous.json", e);
  assertAmbiguousReplyUnresolved(e);
  await sendChatMessage(page, "I approve only the welcome note proposal. Record that decision, but do not start execution or create a task yet. Leave the poster proposal pending.");
  await context.idle(3);
  let cards = await api.get<Row[]>(cardsPath);
  const yes = (await context.comments()).filter(c => !c.authorAgentId && c.body.includes("I approve only")).at(-1)!;
  expect(cards.find(c => c.id === note.id)).toMatchObject({ status: "accepted", result: { commentId: yes.id } });
  expect(cards.find(c => c.id === poster.id)?.status).toBe("pending");
  await sendChatMessage(page, "No, do not proceed with the poster. Reject that proposal. We are still not starting any work.");
  await context.idle(4);
  cards = await api.get<Row[]>(cardsPath);
  const no = (await context.comments()).filter(c => !c.authorAgentId && c.body.includes("No, do not proceed")).at(-1)!;
  expect(cards.find(c => c.id === poster.id)).toMatchObject({ status: "rejected", result: { commentId: no.id } });
  expect(await api.get<Row[]>(`/api/companies/${input.fixtures.company.id}/issues`)).toHaveLength(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  for (const [id, status] of [[note.id, "accepted"], [poster.id, "rejected"]]) {
    await expect(page.locator(`[id="interaction-${id}"]`).getByTestId("interaction-status-badge")).toHaveText(status!);
  }
  await input.evidence("confirmation-decisions.json", { cards, comments: await context.comments(), activity: await api.get(`/api/issues/${issue.id}/activity`) });
  await input.capture("final-state", "Conversational approval and rejection persisted", "final-state.png");
}
