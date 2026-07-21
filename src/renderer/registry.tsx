/**
 * Whitelist mapping AI-renderable component names → React components. The
 * <Surface> only renders names present here — never arbitrary JSX. Keys must
 * match AI_COMPONENTS in core/types.ts.
 */
import type { ComponentType } from 'react';
import { Panel } from './components/Panel.tsx';
import { StatTile } from './components/StatTile.tsx';
import { Card } from './components/Card.tsx';
import { DataTable } from './components/DataTable.tsx';
import { Markdown } from './components/Markdown.tsx';
import { LogFeed } from './components/LogFeed.tsx';
import { AgentStatus } from './components/AgentStatus.tsx';
import { ProjectList } from './components/ProjectList.tsx';

export const REGISTRY: Record<string, ComponentType<any>> = {
  Panel,
  StatTile,
  Card,
  DataTable,
  Markdown,
  LogFeed,
  AgentStatus,
  ProjectList,
};
