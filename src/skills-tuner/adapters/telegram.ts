import { Adapter } from "../core/interfaces.js";
import type { Alternative, Proposal } from "../core/types.js";
import type { CallbackHandler } from "./base.js";
import { elidePath, renderProposalBody, stripInlineMarkup } from "./renderable.js";

/** Telegram limits: `callback_data` is 1-64 BYTES and rejects the whole
 *  message past it; `text` is 4096 characters. The button count is capped for
 *  readability, not by the API — a phone keyboard of forty buttons is not a
 *  usable surface. */
const MAX_CALLBACK_DATA_BYTES = 64;
const MAX_TEXT = 4096;
const MAX_BUTTONS_PER_ROW = 2;
const MAX_APPLY_BUTTONS = 20;
/** Characters that open an entity under `parse_mode: "Markdown"`. An
 *  unterminated one costs the whole message, not the run it sits in. */
/** Header budget for the one unbounded field it interpolates. */
const MAX_TARGET_PATH = 200;
const TELEGRAM_MARKUP = "*_`[";

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
    // `callback_data` is limited to 64 BYTES and `handleCallback` parses the
    // alternative id back out of it, so an over-long id cannot be truncated —
    // and going over rejects the whole sendMessage with BUTTON_DATA_INVALID,
    // costing the operator the entire proposal rather than one button.
    //
    // The body is cut between alternative blocks, never inside one, and every
    // interpolated field has its markup characters removed first: `parse_mode`
    // is set, so a single unclosed `_` turns "too long" into "can't find end
    // of entity" and Telegram drops the message entirely.
    const { shown, text } = this.renderBody(proposal);

    // Chunked: a single row of a dozen buttons is unusable on a phone, which
    // is where these are read.
    const applyRows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < shown.length; i += MAX_BUTTONS_PER_ROW) {
      applyRows.push(
        shown.slice(i, i + MAX_BUTTONS_PER_ROW).map((alt) => ({
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

  /** Header, kept alternative blocks and gap notice, within `MAX_TEXT`. */
  private renderBody(proposal: Proposal): { shown: Alternative[]; text: string } {
    return renderProposalBody(proposal, {
      identifiers: [
        {
          build: (alt) => "apply:" + proposal.id + ":" + alt.id,
          max: MAX_CALLBACK_DATA_BYTES,
          measure: (v) => Buffer.byteLength(v, "utf8"),
        },
      ],
      maxButtons: MAX_APPLY_BUTTONS,
      maxText: MAX_TEXT,
      header: this.formatHeader(proposal),
      block: (alt) => this.formatAlternative(alt),
    });
  }

  formatHeader(proposal: Proposal): string {
    return (
      "Proposal #" +
      proposal.id +
      " - " +
      proposal.subject +
      "/" +
      proposal.kind +
      "\n\n" +
      "Target: `" +
      elidePath(stripInlineMarkup(proposal.target_path, TELEGRAM_MARKUP), MAX_TARGET_PATH) +
      "`"
    );
  }

  formatAlternative(a: Alternative): string {
    return (
      "*" +
      a.id +
      ".* " +
      stripInlineMarkup(a.label, TELEGRAM_MARKUP) +
      "\n   _" +
      (stripInlineMarkup(a.tradeoff || "", TELEGRAM_MARKUP) || "no tradeoff") +
      "_"
    );
  }

  formatProposalText(proposal: Proposal, only?: readonly Alternative[]): string {
    return [
      this.formatHeader(proposal),
      ...(only ?? proposal.alternatives).map((a) => this.formatAlternative(a)),
    ].join("\n\n");
  }
}
