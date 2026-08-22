import { Adapter } from "../core/interfaces.js";
import type { Alternative, Proposal } from "../core/types.js";
import { elidePath, renderProposalBody, stripInlineMarkup } from "./renderable.js";
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
/** Slack caps an `actions` block at 25 elements and rejects the message past
 *  it. Refuse and Edit take two, leaving 23 for Apply buttons. */
const MAX_ACTIONS_ELEMENTS = 25;
const MAX_APPLY_BUTTONS = MAX_ACTIONS_ELEMENTS - 2;
/** Section-block text limit. */
const MAX_SECTION_TEXT = 3000;

const MAX_BUTTON_TEXT = 75; // chars
const MAX_ACTION_VALUE = 2000; // chars
const MAX_ACTION_ID = 255; // chars
/** Characters that open a markup entity in Slack `mrkdwn`. */
/** Header budget for the one unbounded field it interpolates. */
const MAX_TARGET_PATH = 200;
const SLACK_MARKUP = "*_~`";

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
    // Two independent limits ride on the same button. `value` is what
    // `handleAction` parses back; `action_id` has to stay UNIQUE inside the
    // actions block, and Slack bounds it four times tighter. Bounding only
    // `value` let two alternatives whose ids diverge past character 255
    // collapse onto one `action_id` — Slack then rejects the whole block, the
    // exact failure this guard exists to prevent. Both are checked, so neither
    // is truncated below.
    const { shown, text: headerText } = renderProposalBody(proposal, {
      identifiers: [
        { build: (alt) => "apply:" + proposal.id + ":" + alt.id, max: MAX_ACTION_VALUE },
        {
          build: (alt) => "tuner_apply_" + proposal.id + "_" + alt.id,
          max: MAX_ACTION_ID,
        },
      ],
      maxButtons: MAX_APPLY_BUTTONS,
      maxText: MAX_SECTION_TEXT,
      header: this.formatHeader(proposal),
      block: (alt) => this.formatAlternative(alt),
    });

    const elements = [
      ...shown.map((alt) => ({
        type: "button",
        text: {
          type: "plain_text",
          text: truncate("Apply " + alt.id + ": " + alt.label, MAX_BUTTON_TEXT),
        },
        value: "apply:" + proposal.id + ":" + alt.id,
        action_id: "tuner_apply_" + proposal.id + "_" + alt.id,
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

  formatHeader(proposal: Proposal): string {
    return (
      "*Proposal #" +
      proposal.id +
      "* — " +
      proposal.subject +
      "/" +
      proposal.kind +
      "\n\n" +
      "Target: `" +
      elidePath(stripInlineMarkup(proposal.target_path, SLACK_MARKUP), MAX_TARGET_PATH) +
      "`"
    );
  }

  formatAlternative(a: Alternative): string {
    return (
      "*" +
      a.id +
      ".* " +
      stripInlineMarkup(a.label, SLACK_MARKUP) +
      "\n  _" +
      (stripInlineMarkup(a.tradeoff || "", SLACK_MARKUP) || "no tradeoff") +
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
