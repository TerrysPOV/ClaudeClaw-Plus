import { Adapter } from "../core/interfaces.js";
import type { Proposal } from "../core/types.js";
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
const MAX_BUTTON_LABEL = 80;
const MAX_CUSTOM_ID = 100;

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
    const content = this.formatProposalText(proposal);

    // Action row 1: one Apply button per alternative (Discord allows ≤5 buttons/row;
    // alternatives are capped at 3 by AlternativeSchema so this always fits).
    const applyRow = {
      type: COMPONENT_ACTION_ROW,
      components: proposal.alternatives.map((alt) => ({
        type: COMPONENT_BUTTON,
        style: BUTTON_STYLE_PRIMARY,
        label: truncate("Apply " + alt.id + ": " + alt.label, MAX_BUTTON_LABEL),
        custom_id: truncate("apply:" + proposal.id + ":" + alt.id, MAX_CUSTOM_ID),
      })),
    };

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
        components: [applyRow, decisionRow],
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

  formatProposalText(proposal: Proposal): string {
    const altLines = proposal.alternatives
      .map((a) => "**" + a.id + ".** " + a.label + "\n   _" + (a.tradeoff || "no tradeoff") + "_")
      .join("\n\n");
    return (
      "**Proposal #" +
      proposal.id +
      "** - " +
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}
