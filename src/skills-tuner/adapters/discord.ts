import { Adapter } from "../core/interfaces.js";
import type { Alternative, Proposal } from "../core/types.js";
import { elidePath, renderProposalBody, stripInlineMarkup } from "./renderable.js";
import type { CallbackHandler } from "./base.js";

export interface DiscordAdapterConfig {
  /** Discord bot token. Sent only via Authorization header; never embedded in URLs. */
  botToken: string;
  /** Snowflake of the channel where proposals are rendered. */
  channelId: string;
  /** Override Discord REST base URL (test/mocking only). */
  baseUrl?: string;
  /** Fires when a user clicks a proposal action button. */
  callbackHandler?: CallbackHandler;
  /** Snowflake user IDs allowed to act on proposals. Empty list is rejected. */
  allowedUserIds: string[];
  /** Optional guard: verify the proposal still exists / belongs to user before acting. */
  verifyProposalFn?: (proposalId: number) => Promise<boolean>;
}

// Discord component types / styles
const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_PRIMARY = 1; // Apply alternatives
const BUTTON_STYLE_SECONDARY = 2; // Edit
const BUTTON_STYLE_DANGER = 4; // Refuse

// Discord limits we enforce defensively
/** Discord API limits: 5 buttons per action row, 5 rows per message. The last
 *  row carries Refuse + Edit, so four are left for Apply buttons. Exceeding
 *  either rejects the whole message with 400 — it does not truncate. */
const MAX_BUTTONS_PER_ROW = 5;
const MAX_APPLY_ROWS = 4;
const MAX_APPLY_BUTTONS = MAX_BUTTONS_PER_ROW * MAX_APPLY_ROWS;
/** `content` limit. The proposal text carries one label + tradeoff line per
 *  alternative, both unbounded strings, so this is reached well before the
 *  button budget is. */
const MAX_CONTENT = 2000;

const MAX_BUTTON_LABEL = 80;
const MAX_CUSTOM_ID = 100;
/** Characters that open a markup entity in a Discord message body. */
/** Header budget for the one unbounded field it interpolates. */
const MAX_TARGET_PATH = 200;
const DISCORD_MARKUP = "*_~`|";

export class DiscordAdapter extends Adapter {
  constructor(private cfg: DiscordAdapterConfig) {
    super();
    if (!cfg.allowedUserIds || cfg.allowedUserIds.length === 0) {
      throw new Error("DiscordAdapter requires at least one allowedUserId");
    }
    if (!cfg.botToken) {
      throw new Error("DiscordAdapter requires botToken");
    }
    if (!cfg.channelId) {
      throw new Error("DiscordAdapter requires channelId");
    }
  }

  async renderProposal(proposal: Proposal): Promise<void> {
    const baseUrl = this.cfg.baseUrl ?? "https://discord.com/api/v10";
    // `custom_id` is parsed back out in `handleCallback` to recover the
    // alternative id, so truncating it produces a button that renders, looks
    // clickable, and resolves to an alternative no subject can find. An
    // alternative whose id will not fit is left out and counted instead.
    //
    // Buttons and body are budgeted together: twenty ordinary alternatives
    // exceed the content limit on text alone, well before the button budget
    // bites, so deciding the buttons first would render buttons for
    // alternatives the body no longer describes.
    const { shown, content } = this.renderBody(proposal);

    // Apply buttons, chunked across action rows.
    const applyButtons = shown.map((alt) => ({
      type: COMPONENT_BUTTON,
      style: BUTTON_STYLE_PRIMARY,
      label: truncate("Apply " + alt.id + ": " + alt.label, MAX_BUTTON_LABEL),
      custom_id: "apply:" + proposal.id + ":" + alt.id,
    }));
    const applyRows: Array<{ type: number; components: typeof applyButtons }> = [];
    for (let i = 0; i < applyButtons.length; i += MAX_BUTTONS_PER_ROW) {
      applyRows.push({
        type: COMPONENT_ACTION_ROW,
        components: applyButtons.slice(i, i + MAX_BUTTONS_PER_ROW),
      });
    }

    // Action row 2: Refuse + Edit
    const decisionRow = {
      type: COMPONENT_ACTION_ROW,
      components: [
        {
          type: COMPONENT_BUTTON,
          style: BUTTON_STYLE_DANGER,
          label: "Refuse",
          custom_id: truncate("refuse:" + proposal.id, MAX_CUSTOM_ID),
        },
        {
          type: COMPONENT_BUTTON,
          style: BUTTON_STYLE_SECONDARY,
          label: "Edit",
          custom_id: truncate("edit:" + proposal.id, MAX_CUSTOM_ID),
        },
      ],
    };

    const res = await fetch(baseUrl + "/channels/" + this.cfg.channelId + "/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bot " + this.cfg.botToken,
      },
      body: JSON.stringify({
        content,
        components: [...applyRows, decisionRow],
      }),
    });
    if (!res.ok) {
      // Read body for context but never echo the bot token. The body itself
      // never contains the token (we sent it in a header).
      throw new Error("Discord createMessage failed: " + res.status + " " + (await res.text()));
    }
  }

  async renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void> {
    const baseUrl = this.cfg.baseUrl ?? "https://discord.com/api/v10";
    await fetch(baseUrl + "/channels/" + this.cfg.channelId + "/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bot " + this.cfg.botToken,
      },
      body: JSON.stringify({
        content:
          "Applied alt " +
          alternativeId +
          " on proposal #" +
          proposal.id +
          " (" +
          proposal.subject +
          ")",
      }),
    });
  }

  async handleCallback(customId: string, fromUserId: string): Promise<void> {
    if (!this.cfg.allowedUserIds.includes(fromUserId)) {
      throw new Error("User " + fromUserId + " not in allowedUserIds");
    }
    const parts = customId.split(":");
    if (parts.length < 2) {
      throw new Error(`Discord callback malformed: '${customId}' (expected action:id[:alt])`);
    }
    const action = parts[0] as "apply" | "refuse" | "edit";
    if (!["apply", "refuse", "edit"].includes(action)) {
      throw new Error(`Discord callback unknown action: '${action}'`);
    }
    const proposalId = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(proposalId) || proposalId < 1) {
      throw new Error(`Discord callback invalid proposalId: '${parts[1]}' in '${customId}'`);
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

  /** Header, kept alternative blocks and gap notice, within `MAX_CONTENT`. */
  private renderBody(proposal: Proposal): { shown: Alternative[]; content: string } {
    const { shown, text } = renderProposalBody(proposal, {
      identifiers: [{ build: (alt) => "apply:" + proposal.id + ":" + alt.id, max: MAX_CUSTOM_ID }],
      maxButtons: MAX_APPLY_BUTTONS,
      maxText: MAX_CONTENT,
      header: this.formatHeader(proposal),
      block: (alt) => this.formatAlternative(alt),
    });
    return { shown, content: text };
  }

  formatHeader(proposal: Proposal): string {
    return (
      "**Proposal #" +
      proposal.id +
      "** - " +
      proposal.subject +
      "/" +
      proposal.kind +
      "\n\n" +
      "Target: `" +
      elidePath(stripInlineMarkup(proposal.target_path, DISCORD_MARKUP), MAX_TARGET_PATH) +
      "`"
    );
  }

  formatAlternative(a: Alternative): string {
    return (
      "**" +
      a.id +
      ".** " +
      stripInlineMarkup(a.label, DISCORD_MARKUP) +
      "\n   _" +
      (stripInlineMarkup(a.tradeoff || "", DISCORD_MARKUP) || "no tradeoff") +
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}
