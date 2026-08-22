import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import {
  convertMarkdownTables,
  sanitizeAssistantVisibleText,
} from "openclaw/plugin-sdk/text-chunking";

export function prepareZalouserReplyText(text: string, tableMode: MarkdownTableMode): string {
  return sanitizeAssistantVisibleText(convertMarkdownTables(text, tableMode));
}
