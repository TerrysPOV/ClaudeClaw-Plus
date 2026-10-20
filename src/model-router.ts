/**
 * Intelligent model routing based on configurable task modes.
 * Each mode defines a name, model, keywords, and optional phrases.
 */

import type { AgenticMode } from "./config";

interface TaskClassification {
  mode: string;
  model: string;
  confidence: number;
  reasoning: string;
  /** The phrase/keyword that selected this mode ("" when no keyword decided it: default fallback, a tie, or a win on the "?" boost alone). */
  matchedKeyword: string;
}

/**
 * Classify a prompt against configurable modes.
 * Phrases are checked first (high priority), then keyword scoring.
 */
export function classifyTask(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): TaskClassification {
  const normalized = prompt.toLowerCase().trim();

  // Phase 1: Check phrases (highest priority)
  for (const mode of modes) {
    if (!mode.phrases) continue;
    for (const phrase of mode.phrases) {
      if (normalized.includes(phrase)) {
        return {
          mode: mode.name,
          model: mode.model,
          confidence: 0.95,
          reasoning: `Matched phrase "${phrase}" → ${mode.name}`,
          matchedKeyword: phrase,
        };
      }
    }
  }

  // Phase 2: Score keywords per mode (tracking the first keyword that matched).
  const scores: { mode: AgenticMode; score: number; firstKeyword: string }[] = modes.map((mode) => {
    let score = 0;
    let firstKeyword = "";
    for (const keyword of mode.keywords) {
      if (normalized.includes(keyword)) {
        score++;
        if (!firstKeyword) firstKeyword = keyword;
      }
    }
    return { mode, score, firstKeyword };
  });

  // Question marks boost modes that have "planning"-style phrases
  const questionMarks = (normalized.match(/\?/g) || []).length;
  if (questionMarks > 0) {
    for (const entry of scores) {
      if (entry.mode.phrases && entry.mode.phrases.length > 0) {
        entry.score += questionMarks * 0.5;
      }
    }
  }

  // Find highest scoring mode
  scores.sort((a, b) => b.score - a.score);
  const top = scores[0];
  const second = scores[1];

  if (top && top.score > 0) {
    if (!second || top.score > second.score) {
      const diff = second ? top.score - second.score : top.score;
      const confidence = Math.min(0.9, 0.6 + diff * 0.1);
      return {
        mode: top.mode.name,
        model: top.mode.model,
        confidence,
        reasoning: `${top.mode.name}: ${top.score}${second ? `, ${second.mode.name}: ${second.score}` : ""}`,
        matchedKeyword: top.firstKeyword,
      };
    }

    // Tie — prefer defaultMode among tied candidates, otherwise first in array
    const tied = scores.filter((s) => s.score === top.score);
    const tiedFallback = tied.find((s) => s.mode.name === defaultMode) ?? top;
    return {
      mode: tiedFallback.mode.name,
      model: tiedFallback.mode.model,
      confidence: 0.6,
      reasoning: `Tie between ${tied.map((s) => s.mode.name).join(", ")} (score: ${top.score}), using ${tiedFallback.mode.name}`,
      // The tie-break picked the mode, not a keyword: no provenance to report.
      matchedKeyword: "",
    };
  }

  // Fallback to default mode
  const fallback = modes.find((m) => m.name === defaultMode) ?? modes[0];
  if (!fallback) {
    return {
      mode: "unknown",
      model: "",
      confidence: 0,
      reasoning: "No modes configured",
      matchedKeyword: "",
    };
  }

  return {
    mode: fallback.name,
    model: fallback.model,
    confidence: 0.5,
    reasoning: `Ambiguous prompt, defaulting to ${fallback.name}`,
    matchedKeyword: "",
  };
}

/**
 * Select the appropriate model based on task classification.
 */
export function selectModel(
  prompt: string,
  modes: AgenticMode[],
  defaultMode: string,
): { model: string; taskType: string; reasoning: string; matchedKeyword: string } {
  const classification = classifyTask(prompt, modes, defaultMode);
  return {
    model: classification.model,
    taskType: classification.mode,
    reasoning: classification.reasoning,
    matchedKeyword: classification.matchedKeyword,
  };
}
