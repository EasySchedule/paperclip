import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, documents, documentRevisions, heartbeatRuns,
  issueComments, issueDocuments, issues, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveConfirmationFromComment } from "../services/confirmation-comment-resolution.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("conversational confirmation resolution", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("confirmation-replies-"); db = createDb(temporary.connectionString); }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function seed(checkbox = false, conversation = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Replies", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Planner", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Proposal", status: "in_progress", assigneeAgentId: agentId,
      ...(conversation ? { conversationAgentId: agentId, conversationUserId: "operator", conversationState: "active", conversationSessionGeneration: 1 } : {}) }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native", contextSnapshot: { issueId, conversationSessionGeneration: 1 } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const svc = issueThreadInteractionService(db);
    const card = await svc.create(issue, checkbox ? {
      kind: "request_checkbox_confirmation", payload: { version: 1, prompt: "Approve selected work?", options: [{ id: "note", label: "Welcome note" }, { id: "poster", label: "Poster" }], minSelected: 1, defaultSelectedOptionIds: ["poster"] },
    } : { kind: "request_confirmation", payload: { version: 1, prompt: "Approve the welcome note?" } }, { agentId });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorUserId: "operator", authorType: "user", body: "Yes, write the welcome note." }).returning();
    const args = { companyId, issueId, interactionId: card.id, actor: { agentId, runId }, input: { commentId: comment.id, decision: "accept" as const, ...(checkbox ? { selectedOptionIds: ["note"] } : {}) } };
    return { args, card, issue, comment, svc, companyId, issueId, agentId, runId };
  }
  const readCard = (id: string) => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id)).then(rows => rows[0]!);
  const audit = (id: string) => db.select().from(activityLog).where(eq(activityLog.entityId, id)).then(rows => rows.filter(row => row.details?.source === "conversation_reply"));

  it.each([false, true])("persists acceptance, explicit selection and source-message audit (checkbox=%s)", async checkbox => {
    const f = await seed(checkbox, true);
    const answer = await resolveConfirmationFromComment(db, f.args);
    expect(answer).toMatchObject({ deduplicated: false, interaction: { status: "accepted", resolvedByAgentId: f.agentId, resolvedByRunId: f.runId, resolvedByUserId: null, result: { outcome: "accepted", commentId: f.comment.id, ...(checkbox ? { selectedOptionIds: ["note"] } : {}) } } });
    expect(await audit(f.issueId)).toMatchObject([{ action: "issue.thread_interaction_accepted", details: { responseCommentId: f.comment.id, responseUserId: "operator" } }]);
  });
  it("records refusal and its reason on the card", async () => {
    const f = await seed();
    const answer = await resolveConfirmationFromComment(db, { ...f.args, input: { commentId: f.comment.id, decision: "reject", reason: "Not needed" } });
    expect(answer.interaction).toMatchObject({ status: "rejected", result: { outcome: "rejected", reason: "Not needed", commentId: f.comment.id } });
  });
  it("serializes simultaneous retries into one decision and one audit record", async () => {
    const f = await seed(true);
    const answers = await Promise.all([resolveConfirmationFromComment(db, f.args), resolveConfirmationFromComment(db, f.args)]);
    expect(answers.map(x => x.deduplicated).sort()).toEqual([false, true]);
    expect(await audit(f.issueId)).toHaveLength(1);
    const before = await readCard(f.card.id);
    await resolveConfirmationFromComment(db, f.args);
    expect(await readCard(f.card.id)).toEqual(before);
  });
  it("does not rewrite an opposite decision or a different checkbox selection", async () => {
    const f = await seed(true);
    await resolveConfirmationFromComment(db, f.args);
    await expect(resolveConfirmationFromComment(db, { ...f.args, input: { commentId: f.comment.id, decision: "reject" } })).rejects.toThrow("different decision");
    await expect(resolveConfirmationFromComment(db, { ...f.args, input: { ...f.args.input, selectedOptionIds: ["poster"] } })).rejects.toThrow("different decision");
    expect((await readCard(f.card.id)).result).toMatchObject({ selectedOptionIds: ["note"] });
  });
  it.each(["deleted", "agent", "system", "agent-attributed", "quarantined", "before-card", "other-task", "other-company", "newer-message", "wrong-user", "reset-command"])("rejects %s answer evidence without effects", async kind => {
    const f = await seed(false, true);
    const change: Record<string, unknown> = kind === "deleted" ? { deletedAt: new Date() }
      : kind === "agent" ? { authorType: "agent", authorAgentId: f.agentId }
      : kind === "system" ? { authorType: "system" }
      : kind === "agent-attributed" ? { createdByRunId: f.runId }
      : kind === "quarantined" ? { sourceTrust: { preset: "low_trust", disposition: "quarantined" } }
      : kind === "before-card" ? { createdAt: new Date(0) }
      : kind === "wrong-user" ? { authorUserId: "somebody-else" }
      : kind === "reset-command" ? { body: "/new" } : {};
    if (kind === "other-task") {
      const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Other proposal", status: "in_progress" }).returning();
      const [otherComment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: otherIssue.id, authorUserId: "operator", authorType: "user", body: "Yes, go ahead." }).returning();
      f.args.input.commentId = otherComment.id;
    } else if (kind === "other-company") {
      const other = await seed();
      f.args.input.commentId = other.comment.id;
    } else if (kind === "newer-message") {
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: "operator", authorType: "user", body: "Wait, do not proceed.", createdAt: new Date(Date.now() + 1000) });
    } else await db.update(issueComments).set(change).where(eq(issueComments.id, f.comment.id));
    await expect(resolveConfirmationFromComment(db, f.args)).rejects.toThrow();
    expect((await readCard(f.card.id)).status).toBe("pending");
    expect(await audit(f.issueId)).toHaveLength(0);
  });
  it.each(["cancelled", "finished", "lost-owner", "wrong-run-task", "reset-generation", "old-card"])("fences %s execution", async kind => {
    const f = await seed(false, true);
    if (kind === "cancelled" || kind === "finished") await db.update(heartbeatRuns).set({ status: kind === "cancelled" ? "cancelled" : "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "lost-owner") await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    if (kind === "wrong-run-task") await db.update(heartbeatRuns).set({ nativeIssueId: null, contextSnapshot: {} }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "reset-generation") await db.update(issues).set({ conversationSessionGeneration: 2 }).where(eq(issues.id, f.issueId));
    if (kind === "old-card") {
      const [boundary] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "operator", body: "/new" }).returning();
      await db.update(issues).set({ conversationBoundaryCommentId: boundary.id }).where(eq(issues.id, f.issueId));
    }
    await expect(resolveConfirmationFromComment(db, f.args)).rejects.toThrow();
    expect((await readCard(f.card.id)).status).toBe("pending");
  });
  it.each(["human_only", "not_creator", "addressee", "toolAction", "secretProposal", "connectionAuthorization", "questions", "closed"])("preserves %s restrictions", async kind => {
    const f = await seed();
    if (kind === "closed") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    else if (kind === "human_only" || kind === "not_creator") await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: kind }).where(eq(issueThreadInteractions.id, f.card.id));
    else if (kind === "addressee") await db.update(issueThreadInteractions).set({ addresseeUserId: "another-user" }).where(eq(issueThreadInteractions.id, f.card.id));
    else if (kind === "questions") await db.update(issueThreadInteractions).set({ kind: "ask_user_questions" }).where(eq(issueThreadInteractions.id, f.card.id));
    else await db.update(issueThreadInteractions).set({ payload: { ...f.card.payload, [kind]: {} } }).where(eq(issueThreadInteractions.id, f.card.id));
    await expect(resolveConfirmationFromComment(db, f.args)).rejects.toThrow();
    expect((await readCard(f.card.id)).status).toBe("pending");
  });
  it.each(["human_only", "not_creator"] as const)("does not promote a user's yes through an additional %s review restriction", async policy => {
    const f = await seed();
    await expect(resolveConfirmationFromComment(db, { ...f.args, actor: { ...f.args.actor, resolverPolicyRestriction: policy } })).rejects.toThrow();
    expect((await readCard(f.card.id)).status).toBe("pending");
    expect(await audit(f.issueId)).toHaveLength(0);
  });
  it("rechecks narrowed permissions on an otherwise matching retry", async () => {
    const f = await seed();
    await resolveConfirmationFromComment(db, f.args);
    await db.update(issueThreadInteractions).set({ effectiveResolverPolicy: "human_only" }).where(eq(issueThreadInteractions.id, f.card.id));
    await expect(resolveConfirmationFromComment(db, f.args)).rejects.toThrow();
    expect((await readCard(f.card.id)).resolvedByUserId).toBeNull();
    expect(await audit(f.issueId)).toHaveLength(1);
  });
  it("does not borrow checkbox defaults, unknown choices, or insufficient selections", async () => {
    const f = await seed(true);
    for (const selectedOptionIds of [undefined, [], ["unknown"], ["note", "note"]]) {
      await expect(resolveConfirmationFromComment(db, { ...f.args, input: { ...f.args.input, selectedOptionIds } })).rejects.toThrow();
    }
    expect((await readCard(f.card.id)).status).toBe("pending");
  });
  it("does not bless a card already accepted through a different channel", async () => {
    const f = await seed();
    await f.svc.acceptInteraction(f.issue, f.card.id, {}, { userId: "operator" });
    await expect(resolveConfirmationFromComment(db, f.args)).rejects.toThrow("different decision");
    expect((await readCard(f.card.id)).resolvedByUserId).toBe("operator");
  });
  it("rejects an obsolete plan revision", async () => {
    const f = await seed();
    const documentId = randomUUID(), revisionId = randomUUID(), nextRevisionId = randomUUID();
    await db.insert(documents).values({ id: documentId, companyId: f.companyId, latestBody: "New plan", latestRevisionId: nextRevisionId });
    await db.insert(documentRevisions).values([{ id: revisionId, documentId, companyId: f.companyId, revisionNumber: 1, body: "Old plan" }, { id: nextRevisionId, documentId, companyId: f.companyId, revisionNumber: 2, body: "New plan" }]);
    await db.insert(issueDocuments).values({ companyId: f.companyId, issueId: f.issueId, documentId, key: "plan" });
    await db.update(issueThreadInteractions).set({ payload: { ...f.card.payload, target: { type: "issue_document", key: "plan", revisionId } } }).where(eq(issueThreadInteractions.id, f.card.id));
    await expect(resolveConfirmationFromComment(db, f.args)).rejects.toThrow();
    expect((await readCard(f.card.id)).status).not.toBe("accepted");
    expect(await audit(f.issueId)).toHaveLength(0);
  });
});
