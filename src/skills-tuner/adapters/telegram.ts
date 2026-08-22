import { Adapter } from "../core/interfaces.js";
import type { Proposal } from "../core/types.js";
import type { CallbackHandler } from "./base.js";

/** Buttons per inline-keyboard row — a phone-width compromise. */
const MAX_BUTTONS_PER_ROW = 2;

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
    const text = this.formatProposalText(proposal);
    // Chunked rather than one row of everything. Telegram has no hard cap
    // small enough to fail here, but the read path no longer bounds
    // `alternatives`, and a single row of a dozen buttons is unusable on a
    // phone — which is where these are read. Nothing is dropped, so there is
    // no truncation to declare.
    const applyRows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < proposal.alternatives.length; i += MAX_BUTTONS_PER_ROW) {
      applyRows.push(
        proposal.alternatives.slice(i, i + MAX_BUTTONS_PER_ROW).map((alt) => ({
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
