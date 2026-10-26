// @ts-check
// Discussion tab: the session split into exchanges, without DOM (testable with Node).
//
// An exchange = what you sent (message, /… command, !… command) then the agent's reply: its texts, its
// actions (tools, grouped as long as it writes nothing in between), its subagents, and command outputs.
// The texts Claude Code slips into the conversation (reminders, file opened in the IDE…) are ignored,
// except those that say something useful.

import { t } from "./i18n.js";

/**
 * @typedef {{type: string, text?: string, id?: string, name?: string, input?: any, toolUseId?: string,
 *   is_error?: boolean, content?: string}} Block
 * @typedef {{id?: string | null, role: string, timestamp?: string, content: Block[], shared?: string}} Message
 * @typedef {{id: string, name: string, input: any, result?: string, isError?: boolean}} Tool
 * @typedef {{kind: "text", text: string} | {kind: "tools", id: string, tools: Tool[]}
 *   | {kind: "subagent", id: string, input: any} | {kind: "output", label: string, text: string}
 *   | {kind: "info", text: string}} Item
 * @typedef {{kind: "prompt" | "command" | "bash", text: string, shared?: string, timestamp?: string}} Sent
 * @typedef {{id: string, sent: Sent | null, items: Item[]}} Turn
 */

export const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * @param {string} text
 * @param {string} tag
 */
const tagContent = (text, tag) => text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim();

/**
 * What a "user" text says: a message from you, a command, an output, or nothing of interest.
 *
 * @param {string} text
 * @returns {{sent: Sent} | {item: Item} | null}
 */
export function classifyUserText(text) {
  if (!/^\s*<[a-z][\w-]*>/.test(text)) return { sent: { kind: "prompt", text } };
  const command = tagContent(text, "command-name");
  if (command) {
    const args = tagContent(text, "command-args");
    return { sent: { kind: "command", text: args ? `${command} ${args}` : command } };
  }
  const bash = tagContent(text, "bash-input");
  if (bash !== undefined) return { sent: { kind: "bash", text: bash } };
  for (const [tag, label] of [["bash-stdout", t("Output")], ["bash-stderr", t("Error")], ["local-command-stdout", t("Output")]]) {
    const output = tagContent(text, tag);
    if (output) return { item: { kind: "output", label, text: output } };
  }
  if (/^\s*<task-notification>/.test(text)) {
    const summary = tagContent(text, "summary");
    return summary ? { item: { kind: "info", text: summary } } : null;
  }
  return null; // system reminder, file opened in the IDE…: nothing to show
}

/**
 * Splits the session into exchanges.
 *
 * @param {Message[]} messages
 * @returns {Turn[]}
 */
export function buildTurns(messages) {
  /** @type {Turn[]} */
  const turns = [];
  /** @type {Turn | null} */
  let turn = null;
  /** @type {Map<string, Tool>} actions waiting for their result */
  const tools = new Map();
  /** @param {string} id */
  const current = (id) => {
    turn ??= { id, sent: null, items: [] };
    if (!turns.includes(turn)) turns.push(turn);
    return turn;
  };
  messages.forEach((message, index) => {
    const id = message.id || `m${index}`;
    for (const block of message.content) {
      if (message.role === "user" && block.type === "text") {
        const found = classifyUserText(block.text ?? "");
        if (found && "sent" in found) {
          turn = { id, sent: { ...found.sent, shared: message.shared, timestamp: message.timestamp }, items: [] };
          turns.push(turn);
        } else if (found) {
          current(id).items.push(found.item);
        }
      } else if (message.role === "user" && block.type === "tool_result") {
        const tool = tools.get(block.toolUseId ?? "");
        if (tool) Object.assign(tool, { result: block.content ?? "", isError: Boolean(block.is_error) });
      } else if (message.role === "assistant" && block.type === "text" && block.text?.trim()) {
        current(id).items.push({ kind: "text", text: block.text });
      } else if (message.role === "assistant" && block.type === "tool_use") {
        const target = current(id);
        if (SUBAGENT_TOOLS.has(block.name ?? "")) {
          target.items.push({ kind: "subagent", id: block.id ?? `${id}-agent`, input: block.input ?? {} });
          continue;
        }
        /** @type {Tool} */
        const tool = { id: block.id ?? `${id}-${target.items.length}`, name: block.name ?? "?", input: block.input };
        tools.set(tool.id, tool);
        const last = target.items.at(-1);
        if (last?.kind === "tools") last.tools.push(tool);
        else target.items.push({ kind: "tools", id: tool.id, tools: [tool] });
      }
    }
  });
  return turns;
}

/**
 * One-line summary of an action: the command, the file, the searched pattern…
 *
 * @param {string} name
 * @param {any} input
 */
export function toolSummary(name, input) {
  const value = input?.command ?? input?.file_path ?? input?.notebook_path ?? input?.pattern ?? input?.url
    ?? input?.query ?? input?.description ?? input?.prompt;
  const text = typeof value === "string" ? value : input ? JSON.stringify(input) : "";
  const short = /_path$/.test(Object.keys(input ?? {}).find((key) => input[key] === value) ?? "")
    ? text.split("/").slice(-2).join("/")
    : text;
  const line = short.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/**
 * Names of the actions of a group, without duplicates, in order ("Bash, Read, Edit").
 *
 * @param {Tool[]} tools
 */
export const toolNames = (tools) => [...new Set(tools.map((tool) => tool.name))].join(", ");

/**
 * Reply of an exchange as text: the agent's messages, without its actions or outputs.
 *
 * @param {Turn} turn
 */
export const replyText = (turn) =>
  turn.items.filter((item) => item.kind === "text").map((item) => /** @type {{text: string}} */ (item).text.trim()).join("\n\n");

/**
 * What you sent, as is (a command keeps its "/" or "!").
 *
 * @param {Sent} sent
 */
export const sentText = (sent) => (sent.kind === "bash" ? `! ${sent.text}` : sent.text);

/**
 * Exchange to copy or export, in Markdown: the question then the answer, or the answer alone.
 *
 * @param {Turn} turn
 * @param {boolean} withQuestion
 */
export function turnMarkdown(turn, withQuestion) {
  const reply = replyText(turn);
  if (!withQuestion || !turn.sent) return reply;
  return `## ${t("Question")}\n\n${sentText(turn.sent)}\n\n## ${t("Answer")}\n\n${reply || `_${t("No written answer.")}_`}`;
}
