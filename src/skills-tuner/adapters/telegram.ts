import { Adapter } from "../core/interfaces.js";
import type { Proposal } from "../core/types.js";
import type { CallbackHandler } from "./base.js";

/** Buttons per inline-keyboard row — a phone-width compromise. */
const MAX_BUTTONS_PER_ROW = 2;

/** Telegram rejects the WHOLE sendMessage if any button's `callback_data`
 *  exceeds this, with BUTTON_DATA_INVALID. `alternatives[].id` is an unbounded
 *  string, so this is reachable — and unlike Discord's `custom_id`, truncating
 *  is not an option: the callback handler parses the id back out of it. */
const MAX_CALLBACK_DATA_BYTES = 64;

/** Telegram's sendMessage text limit. */
const MAX_TEXT = 4096;

export interface TelegramAdapterConfig {
  botToken: string;
  chatId: string;
  baseUrl?: string;
  callbackHandler?: CallbackHandler;
  allowedUserIds: number[];
  verifyProposalFn?: (proposalId: number) => Promise<boolean>;
}

export class TelegramAdapter extends Adapter {
  constructor(private cfg: TelegramAdapterConfig) {
    super();
    if (!cfg.allowedUserIds || cfg.allowedUserIds.length === 0) {
      throw new Error("TelegramAdapter requires at least one allowedUserId");
    }
  }

  async renderProposal(proposal: Proposal): Promise<void> {
    const baseUrl = this.cfg.baseUrl ?? "https://api.telegram.org";
    const rawText = this.formatProposalText(proposal);
    // Chunked rather than one row of everything: the read path no longer
    // bounds `alternatives`, and a single row of a dozen buttons is unusable
    // on a phone, which is where these are read.
    //
    // A button whose callback payload is over Telegram's limit is left out
    // rather than allowed to sink the whole message. That is a real
    // possibility, not a theoretical one — the alternative id is an unbounded
    // string — and dropping ONE button beats delivering none.
    const usable = proposal.alternatives.filter(
      (alt) =>
        Buffer.byteLength("apply:" + proposal.id + ":" + alt.id, "utf8") <= MAX_CALLBACK_DATA_BYTES,
    );
    const droppedCount = proposal.alternatives.length - usable.length;
    const notice =
      droppedCount > 0
        ? `\n\n${usable.length} of ${proposal.alternatives.length} alternatives have a button here; apply the rest with tuner__apply.`
        : "";
    // Body trimmed first so the notice survives, and so the message fits at
    // all: the proposal text grows with the alternative count.
    const text = rawText.slice(0, MAX_TEXT - notice.length) + notice;

    const applyRows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < usable.length; i += MAX_BUTTONS_PER_ROW) {
      applyRows.push(
        usable.slice(i, i + MAX_BUTTONS_PER_ROW).map((alt) => ({
          text: "Apply " + alt.id + ": " + alt.label.slice(0, 30),
          callback_data: "apply:" + proposal.id + ":" + alt.id,
        })),
      );
    }
    const reply_markup = {
      inline_keyboard: [
        ...applyRows,
        [
          { text: "Refuse", callback_data: "refuse:" + proposal.id },
          { text: "Edit", callback_data: "edit:" + proposal.id },
        ],
      ],
    };

    const res = await fetch(baseUrl + "/bot" + this.cfg.botToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.cfg.chatId,
        text,
        parse_mode: "Markdown",
        reply_markup,
      }),
    });
    if (!res.ok) {
      throw new Error("Telegram sendMessage failed: " + res.status + " " + (await res.text()));
    }
  }

  async renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void> {
    const baseUrl = this.cfg.baseUrl ?? "https://api.telegram.org";
    await fetch(baseUrl + "/bot" + this.cfg.botToken + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.cfg.chatId,
        text:
          "Applied alt " +
          alternativeId +
          " on proposal #" +
          proposal.id +
          " (" +
          proposal.subject +
          ")",
        parse_mode: "Markdown",
      }),
    });
  }

  async handleCallback(callbackData: string, fromUserId: number): Promise<void> {
    if (!this.cfg.allowedUserIds.includes(fromUserId)) {
      throw new Error("User " + fromUserId + " not in allowedUserIds");
    }
    const parts = callbackData.split(":");
    if (parts.length < 2) {
      throw new Error(`Telegram callback malformed: '${callbackData}' (expected action:id[:alt])`);
    }
    const action = parts[0] as "apply" | "refuse" | "edit";
    if (!["apply", "refuse", "edit"].includes(action)) {
      throw new Error(`Telegram callback unknown action: '${action}'`);
    }
    const proposalId = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(proposalId) || proposalId < 1) {
      throw new Error(`Telegram callback invalid proposalId: '${parts[1]}' in '${callbackData}'`);
    }
    const alternativeId = parts[2];
    if (this.cfg.verifyProposalFn) {
      const valid = await this.cfg.verifyProposalFn(proposalId);
      if (!valid) {
        throw new Error(
          "verifyProposalFn rejected proposal " + proposalId + " for user " + fromUserId,
        );
      }
    }
    if (this.cfg.callbackHandler) {
      await this.cfg.callbackHandler({ proposalId, alternativeId, action });
    }
  }

  formatProposalText(proposal: Proposal): string {
    const altLines = proposal.alternatives
      .map((a) => "*" + a.id + ".* " + a.label + "\n   _" + (a.tradeoff || "no tradeoff") + "_")
      .join("\n\n");
    return (
      "Proposal #" +
      proposal.id +
      " - " +
      proposal.subject +
      "/" +
      proposal.kind +
      "\n\n" +
      "Target: `" +
      proposal.target_path +
      "`\n\n" +
      altLines
    );
  }
}
