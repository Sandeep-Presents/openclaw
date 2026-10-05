import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { listModelAliasCandidates } from "../../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillCommandSpec } from "../../skills/types.js";

export function reserveSkillCommandNames(params: {
  reservedCommands: Set<string>;
  skillCommands: SkillCommandSpec[];
}) {
  for (const command of params.skillCommands) {
    params.reservedCommands.add(normalizeLowercaseStringOrEmpty(command.name));
  }
}

export function listConfiguredDirectiveAliases(cfg: OpenClawConfig, agentId?: string) {
  return listModelAliasCandidates(cfg, agentId)
    .map((candidate) => candidate.alias)
    .filter(Boolean);
}

export function resolveConfiguredDirectiveAliases(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  commandTextHasSlash: boolean;
  reservedCommands: Set<string>;
}) {
  if (!params.commandTextHasSlash) {
    return [];
  }
  return listConfiguredDirectiveAliases(params.cfg, params.agentId).filter(
    (alias) => !params.reservedCommands.has(normalizeLowercaseStringOrEmpty(alias)),
  );
}
