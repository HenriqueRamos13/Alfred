/**
 * Tool authoring surface. The canonical definitions live in core/types.ts;
 * tool files import from here so they only pull what they need.
 */
export type {
  Tool,
  ToolCtx,
  ToolResult,
  JSONSchema,
  RiskTier,
  Governance,
  Secrets,
  BrowserHandle,
  UiNode,
  RenderUiPayload,
  StreamEvent,
} from '../core/types.ts';
