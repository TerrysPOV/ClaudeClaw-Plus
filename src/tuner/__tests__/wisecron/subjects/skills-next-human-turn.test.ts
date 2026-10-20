import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsSubject } from "../../../subjects/skills-subject.js";

type Rec = Record<string, unknown>;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(
  records: Rec[],
  overrides: Record<string, { triggers: unknown[] }> = {
    lights: { triggers: ["turn on the lights"] },
  },
  skills: string[] = ["lights"],
) {
  const root = mkdtempSync(join(tmpdir(), "skills-next-turn-"));
  roots.push(root);
  const skillsDir = join(root, "skills");
  for (const n of skills) {
    mkdirSync(join(skillsDir, n), { recursive: true });
    writeFileSync(join(skillsDir, n, "SKILL.md"), `---\nname: ${n}\ndescription: d\n---\nbody\n`);
  }
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "p1"), { recursive: true });
  writeFileSync(
    join(projectsDir, "p1", "s1.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return new SkillsSubject({
    scanDirs: [skillsDir],
    projectsDir,
    skillAccessLog: join(root, "access.jsonl"),
    qualityCachePath: join(root, "quality.json"),
    overrides: overrides as Record<string, { triggers: string[] }>,
  });
}

const since = () => new Date(Date.now() - 3_600_000);
const ts = new Date().toISOString();
const human = (text: string, extra: Rec = {}): Rec => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (text: string): Rec => ({
  type: "assistant",
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolResult = (): Rec => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
  toolUseResult: { stdout: "ok" },
});
// A loaded skill body: Claude Code writes it as a "user" record. Its text is
// deliberately full of words the correction regex would match.
const skillBody = (): Rec =>
  human("Base directory for this skill. No, never do this; that is wrong, stop.", {
    isMeta: true,
    sourceToolUseID: "toolu_1",
  });
const hookFeedback = (): Rec => human("Stop hook feedback: no, that is wrong", { isMeta: true });
const compactSummary = (): Rec =>
  human("Summary: the user said no, wrong", { isCompactSummary: true });
const sidechain = (): Rec => human("no, that's wrong", { isSidechain: true });
const notification = (): Rec => human("<task-notification>no, wrong</task-notification>");
const localCmd = (): Rec => human("<local-command-stdout>no, wrong</local-command-stdout>");

describe("SkillsSubject reaction = next human turn", () => {
  test("finds the correction past a long agentic turn", async () => {
    const subject = setup([
      human("please turn on the lights"),
      assistant("a"),
      assistant("b"),
      toolResult(),
      assistant("c"),
      assistant("d"),
      assistant("e"),
      human("no, that's wrong"),
    ]);
    const obs = await subject.collectObservations(since());
    expect(obs.map((o) => o.signal_type)).toEqual(["correction"]);
  });

  test("a tool_result record right after the prompt is not taken as the reaction", async () => {
    const subject = setup([
      human("please turn on the lights"),
      toolResult(),
      human("no, that's wrong"),
    ]);
    expect((await subject.collectObservations(since())).length).toBe(1);
  });

  test("injected user-typed records are skipped; the real reaction wins", async () => {
    const subject = setup([
      human("please turn on the lights"),
      assistant("loading"),
      toolResult(),
      skillBody(),
      hookFeedback(),
      compactSummary(),
      sidechain(),
      notification(),
      localCmd(),
      assistant("done"),
      human("perfect, thanks"),
    ]);
    const obs = await subject.collectObservations(since());
    expect(obs.map((o) => o.signal_type)).toEqual(["positive_feedback"]);
  });

  test("injected records alone never produce an observation", async () => {
    const subject = setup([
      human("please turn on the lights"),
      toolResult(),
      skillBody(),
      hookFeedback(),
      compactSummary(),
      sidechain(),
      notification(),
      localCmd(),
    ]);
    expect(await subject.collectObservations(since())).toEqual([]);
  });

  test("an injected record is never taken as the triggering prompt", async () => {
    const subject = setup([
      human("turn on the lights", { isMeta: true, sourceToolUseID: "toolu_1" }),
      human("no, that's wrong"),
    ]);
    expect(await subject.collectObservations(since())).toEqual([]);
  });

  test("a channel message flagged isMeta is a human turn", async () => {
    const subject = setup([
      human('<channel source="bus">please turn on the lights</channel>', { isMeta: true }),
      assistant("ok"),
      toolResult(),
      human('<channel source="bus">no, that\'s wrong</channel>', { isMeta: true }),
    ]);
    const obs = await subject.collectObservations(since());
    expect(obs.map((o) => o.signal_type)).toEqual(["correction"]);
  });

  test("each non-human marker is enough on its own to skip a record", async () => {
    const shapes: Rec[] = [
      human("no, that's wrong", { sourceToolUseID: "toolu_1" }),
      human("no, that's wrong", { toolUseResult: { stdout: "x" } }),
      human("no, that's wrong", { isMeta: true }),
      human("no, that's wrong", { isCompactSummary: true }),
      human("no, that's wrong", { isSidechain: true }),
    ];
    for (const shape of shapes) {
      const subject = setup([human("please turn on the lights"), shape]);
      expect(await subject.collectObservations(since())).toEqual([]);
    }
  });

  test("channel messages sent by the daemon itself are not human turns", async () => {
    const shapes = [
      '<channel source="bus" origin="webui" origin_id="inject">no, that\'s wrong</channel>',
      '<channel source="bus" origin="webui" origin_id="job:default/x">no, that\'s wrong</channel>',
      '<channel source="bus" origin_id="agent-job:7" user_id="system">no, that\'s wrong</channel>',
      '<channel source="cron" chat_id="c">no, that\'s wrong</channel>',
      '<channel source="webui" chat_id="inject" user_id="webui">no, that\'s wrong</channel>',
      '<channel source="webui" chat_id="job:default/x" user_id="webui">no, that\'s wrong</channel>',
      '<channel source="bus" origin="telegram" origin_id="42" nudge="reply-tool">no, that\'s wrong</channel>',
      '<channel source="bus" origin="heartbeat" origin_id="bus-scheduler:h">no, that\'s wrong</channel>',
      '<channel source="bus" origin="cron" origin_id="x">no, that\'s wrong</channel>',
      '<channel source="bus" origin="webui" origin_id="bus-scheduler:c">no, that\'s wrong</channel>',
      '<channel source="bus" no, that\'s wrong',
    ];
    for (const text of shapes) {
      const subject = setup([human("please turn on the lights"), human(text, { isMeta: true })]);
      expect(await subject.collectObservations(since())).toEqual([]);
    }
  });

  test("a channel message whose body mentions inject is still human", async () => {
    const subject = setup([
      human("please turn on the lights"),
      human(
        '<channel source="bus" origin="telegram" origin_id="42">no, wrong: origin_id="inject"</channel>',
        {
          isMeta: true,
        },
      ),
    ]);
    expect((await subject.collectObservations(since())).length).toBe(1);
  });

  test("a human channel message delivered over the PTY is a human turn", async () => {
    const subject = setup([
      human("please turn on the lights"),
      human('<channel source="telegram" chat_id="42" user_id="42">no, that\'s wrong</channel>'),
    ]);
    expect((await subject.collectObservations(since())).length).toBe(1);
  });

  test("a human turn without text (image only) ends the search", async () => {
    const image: Rec = {
      type: "user",
      timestamp: ts,
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", data: "x" } }],
      },
    };
    const subject = setup([
      human("please turn on the lights"),
      assistant("a"),
      image,
      assistant("b"),
      human("no, that's wrong"),
    ]);
    // The later correction answers the image turn, not the lights prompt.
    expect(await subject.collectObservations(since())).toEqual([]);
  });

  test("a tool_result record without toolUseResult is still not a human turn", async () => {
    const bare = toolResult();
    delete bare["toolUseResult"];
    const subject = setup([human("please turn on the lights"), bare, human("no, that's wrong")]);
    expect((await subject.collectObservations(since())).length).toBe(1);
  });

  test("no next human turn → no observation", async () => {
    const subject = setup([human("please turn on the lights"), assistant("a"), toolResult()]);
    expect(await subject.collectObservations(since())).toEqual([]);
  });
});

describe("SkillsSubject override triggers", () => {
  const session = [
    human("something unrelated"),
    human("please turn on the lights"),
    human("no, that's wrong"),
  ];

  test("a non-string override trigger does not drop the whole session", async () => {
    const subject = setup(
      session,
      { zzz: { triggers: [{ keywords: ["x"] }] }, lights: { triggers: ["turn on the lights"] } },
      ["lights", "zzz"],
    );
    expect((await subject.collectObservations(since())).length).toBe(1);
  });

  test("non-string entries are dropped, string entries kept", async () => {
    const subject = setup(session, { lights: { triggers: [{ k: 1 }, "turn on the lights", 7] } });
    expect((await subject.collectObservations(since())).length).toBe(1);
  });

  test("an override with no usable string falls back to the skill's own triggers", async () => {
    // Fallback is the skill name ("lights"), present in the prompt.
    const subject = setup(session, { lights: { triggers: [{ k: 1 }, ""] } });
    expect((await subject.collectObservations(since())).length).toBe(1);
  });

  test("empty-string and null frontmatter triggers do not match", async () => {
    const root = mkdtempSync(join(tmpdir(), "skills-fm-"));
    roots.push(root);
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "zzz"), { recursive: true });
    writeFileSync(
      join(skillsDir, "zzz", "SKILL.md"),
      '---\nname: zzz\ntriggers: ["", "  ", null]\n---\nbody\n',
    );
    const projectsDir = join(root, "projects");
    mkdirSync(join(projectsDir, "p1"), { recursive: true });
    writeFileSync(
      join(projectsDir, "p1", "s1.jsonl"),
      [human("set it to null"), human("no, that's wrong")]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    const subject = new SkillsSubject({
      scanDirs: [skillsDir],
      projectsDir,
      skillAccessLog: join(root, "access.jsonl"),
      qualityCachePath: join(root, "quality.json"),
    });
    expect(await subject.collectObservations(since())).toEqual([]);
  });

  test("an empty override list still disables matching for that skill", async () => {
    const subject = setup(session, { lights: { triggers: [] } });
    expect(await subject.collectObservations(since())).toEqual([]);
  });
});
