import { Adapter } from "../core/interfaces.js";
import type { Proposal } from "../core/types.js";
import type { CallbackHandler } from "./base.js";

export interface SlackAdapterConfig {
  /** Slack xoxb-… bot token. Sent only via Authorization header; never embedded in URLs. */
  botToken: string;
  /** Channel ID (e.g. C0123456) where proposals are rendered. */
  channelId: string;
  /** Override Slack Web API base URL (test/mocking only). */
  baseUrl?: string;
  /** Fires when a user clicks a proposal action button. */
  callbackHandler?: CallbackHandler;
  /** Slack user IDs (e.g. U12345678) allowed to act on proposals. Empty list is rejected. */
  allowedUserIds: string[];
  /** Optional guard: verify the proposal still exists before acting. */
  verifyProposalFn?: (proposalId: number) => Promise<boolean>;
}

// Slack Block Kit limits we enforce defensively
const MAX_BUTTON_TEXT = 75; // chars
const MAX_ACTION_VALUE = 2000; // chars
const MAX_ACTION_ID = 255; // chars

export class SlackAdapter extends Adapter {
  constructor(private cfg: SlackAdapterConfig) {
    super();
    if (!cfg.allowedUserIds || cfg.allowedUserIds.length === 0) {
      throw new Error("SlackAdapter requires at least one allowedUserId");
    }
    if (!cfg.botToken) {
      throw new Error("SlackAdapter requires botToken");
    }
    if (!cfg.channelId) {
      throw new Error("SlackAdapter requires channelId");
    }
  }

  async renderProposal(proposal: Proposal): Promise<void> {
    const baseUrl = this.cfg.baseUrl ?? "https://slack.com/api";
    const headerText = this.formatProposalText(proposal);

    // Block Kit actions block — one Apply per alternative + Refuse + Edit.
    // Slack allows up to 25 buttons per `actions` block; alternatives are
    // capped at 3 by AlternativeSchema so the whole row always fits.
    const elements = [
      ...proposal.alternatives.map((alt) => ({
        type: "button",
        text: {
          type: "plain_text",
          text: truncate("Apply " + alt.id + ": " + alt.label, MAX_BUTTON_TEXT),
        },
        value: truncate("apply:" + proposal.id + ":" + alt.id, MAX_ACTION_VALUE),
        action_id: truncate("tuner_apply_" + proposal.id + "_" + alt.id, MAX_ACTION_ID),
        style: "primary",
      })),
      {
        type: "button",
        text: { type: "plain_text", text: "Refuse" },
        value: truncate("refuse:" + proposal.id, MAX_ACTION_VALUE),
        action_id: truncate("tuner_refuse_" + proposal.id, MAX_ACTION_ID),
        style: "danger",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Edit" },
        value: truncate("edit:" + proposal.id, MAX_ACTION_VALUE),
        action_id: truncate("tuner_edit_" + proposal.id, MAX_ACTION_ID),
      },
    ];

    const res = await fetch(baseUrl + "/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: "Bearer " + this.cfg.botToken,
      },
      body: JSON.stringify({
        channel: this.cfg.channelId,
        // text is a fallback for notifications + accessibility; Slack requires
        // a non-empty text field even when blocks carry the visible content.
        text: "Proposal #" + proposal.id + " (" + proposal.subject + ")",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: headerText } },
          { type: "actions", elements },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error("Slack chat.postMessage failed: " + res.status + " " + (await res.text()));
    }
    // Slack returns HTTP 200 with `{ok: false, error: "..."}` on API errors,
    // so we must inspect the parsed body too — but never echo the bot token.
    const json = (await res.json().catch(() => ({}) as Record<string, unknown>)) as {
      ok?: boolean;
      error?: string;
    };
    if (json.ok === false) {
      throw new Error("Slack chat.postMessage error: " + (json.error ?? "unknown"));
    }
  }

  async renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void> {
    const baseUrl = this.cfg.baseUrl ?? "https://slack.com/api";
    await fetch(baseUrl + "/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: "Bearer " + this.cfg.botToken,
      },
      body: JSON.stringify({
        channel: this.cfg.channelId,
        text:
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

  async handleCallback(actionValue: string, fromUserId: string): Promise<void> {
    if (!this.cfg.allowedUserIds.includes(fromUserId)) {
      throw new Error("User " + fromUserId + " not in allowedUserIds");
    }
    const parts = actionValue.split(":");
    if (parts.length < 2) {
      throw new Error(`Slack callback malformed: '${actionValue}' (expected action:id[:alt])`);
    }
    const action = parts[0] as "apply" | "refuse" | "edit";
    if (!["apply", "refuse", "edit"].includes(action)) {
      throw new Error(`Slack callback unknown action: '${action}'`);
    }
    const proposalId = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(proposalId) || proposalId < 1) {
      throw new Error(`Slack callback invalid proposalId: '${parts[1]}' in '${actionValue}'`);
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
      .map((a) => "*" + a.id + ".* " + a.label + "\n  _" + (a.tradeoff || "no tradeoff") + "_")
      .join("\n\n");
    return (
      "*Proposal #" +
      proposal.id +
      "* — " +
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
