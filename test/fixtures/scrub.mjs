#!/usr/bin/env node
// Turns a raw capture into a fixture (CONTRIBUTING.md, "Recorded sessions"): keeps the events of the
// scratch project, and replaces every path and id that says whose machine it was recorded on.
//   node test/fixtures/scrub.mjs <claude-code|codex> <raw.jsonl> <scratch project>
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [name, raw, scratch] = process.argv.slice(2);
if (!name || !raw || !scratch) {
  console.error("usage: scrub.mjs <claude-code|codex> <raw.jsonl> <scratch project>");
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const project = realpathSync(scratch);
const jsonl = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

// Codex also fires hooks for its own housekeeping in ~/.codex; those events are not the project's.
const events = jsonl(raw).filter(
  (e) => typeof e.cwd === "string" && realpathSync(e.cwd) === project,
);
const transcript = events.find((e) => e.transcript_path)?.transcript_path;

// Longest first, so the project path goes before the temp and home directories that contain it.
const replacements = [
  [project, "/repo"],
  [project.replace(/^\/private/, ""), "/repo"],
  [homedir(), "/home/user"],
  [userInfo().username, "user"],
];
const FIXED = {
  session_id: "session",
  prompt_id: "prompt",
  turn_id: "turn",
  thread_id: "thread",
  process_id: "1",
  model: "model",
  scratchpad_dir: "/scratch",
  // The test points this at the rollout fixture; Canny never opens Claude Code's transcript.
  transcript_path: name === "codex" ? "ROLLOUT" : "/home/user/transcript.jsonl",
};
const scrub = (records) =>
  records
    .map((record) => {
      let text = JSON.stringify(record, (key, value) =>
        key in FIXED && value !== null ? FIXED[key] : value,
      );
      for (const [from, to] of replacements) text = text.replaceAll(from, to);
      return text;
    })
    .join("\n") + "\n";

writeFileSync(join(here, `${name}.jsonl`), scrub(events));
if (name === "codex" && transcript) {
  // Only the records Canny reads: the completed commands, which carry the exit codes.
  const ids = new Set(events.map((e) => e.tool_use_id));
  const completed = jsonl(transcript).filter(
    (r) => r.payload?.type === "item_completed" && ids.has(r.payload.item?.id),
  );
  writeFileSync(join(here, "codex-rollout.jsonl"), scrub(completed));
}
console.log(`${events.length} events -> ${join(here, `${name}.jsonl`)}`);
