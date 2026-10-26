// @ts-check
// Onglet Discussion : la session découpée en échanges, sans DOM (testable avec Node).
//
// Un échange = ce que tu as envoyé (message, commande /…, commande !…) puis la réponse de l'agent :
// ses textes, ses actions (outils, regroupés tant qu'il n'écrit rien entre deux), ses sous-agents, et
// les sorties de commandes. Les textes que Claude Code glisse dans la conversation (rappels, fichier
// ouvert dans l'IDE…) sont ignorés, sauf ceux qui disent quelque chose d'utile.

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
 * Ce que dit un texte « utilisateur » : un message à toi, une commande, une sortie, ou rien d'intéressant.
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
  for (const [tag, label] of [["bash-stdout", "Sortie"], ["bash-stderr", "Erreur"], ["local-command-stdout", "Sortie"]]) {
    const output = tagContent(text, tag);
    if (output) return { item: { kind: "output", label, text: output } };
  }
  if (/^\s*<task-notification>/.test(text)) {
    const summary = tagContent(text, "summary");
    return summary ? { item: { kind: "info", text: summary } } : null;
  }
  return null; // rappel système, fichier ouvert dans l'IDE… : rien à montrer
}

/**
 * Découpe la session en échanges.
 *
 * @param {Message[]} messages
 * @returns {Turn[]}
 */
export function buildTurns(messages) {
  /** @type {Turn[]} */
  const turns = [];
  /** @type {Turn | null} */
  let turn = null;
  /** @type {Map<string, Tool>} actions en attente de leur résultat */
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
 * Résumé d'une action sur une ligne : la commande, le fichier, le motif cherché…
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
 * Noms des actions d'un groupe, sans doublon, dans l'ordre (« Bash, Read, Edit »).
 *
 * @param {Tool[]} tools
 */
export const toolNames = (tools) => [...new Set(tools.map((tool) => tool.name))].join(", ");

/**
 * Réponse d'un échange en texte : les messages de l'agent, sans ses actions ni ses sorties.
 *
 * @param {Turn} turn
 */
export const replyText = (turn) =>
  turn.items.filter((item) => item.kind === "text").map((item) => /** @type {{text: string}} */ (item).text.trim()).join("\n\n");

/**
 * Ce que tu as envoyé, tel quel (une commande garde son « / » ou son « ! »).
 *
 * @param {Sent} sent
 */
export const sentText = (sent) => (sent.kind === "bash" ? `! ${sent.text}` : sent.text);

/**
 * Échange à copier ou exporter, en Markdown : la question puis la réponse, ou la réponse seule.
 *
 * @param {Turn} turn
 * @param {boolean} withQuestion
 */
export function turnMarkdown(turn, withQuestion) {
  const reply = replyText(turn);
  if (!withQuestion || !turn.sent) return reply;
  return `## Question\n\n${sentText(turn.sent)}\n\n## Réponse\n\n${reply || "_Pas de réponse écrite._"}`;
}
